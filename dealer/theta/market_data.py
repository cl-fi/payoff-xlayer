"""Exact-contract snapshots and historical last-valid NBBO lookup."""
from datetime import date, datetime, time
from decimal import Decimal, ROUND_FLOOR
from functools import lru_cache
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


class NoValidBid(Exception):
    pass


def epoch_ms(day, clock):
    return int(datetime.combine(day, time.fromisoformat(clock), NY).timestamp() * 1000)


def micros(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0:
        raise ValueError("Invalid price")
    return str(int((number * 1_000_000).to_integral_value(rounding=ROUND_FLOOR)))


class MarketData:
    def __init__(self, client, no_data_error=LookupError):
        self.client = client
        self.no_data_error = no_data_error

    @lru_cache(maxsize=256)
    def session(self, day):
        rows = self.client.calendar_on_date(date=day).to_dicts()
        if len(rows) != 1 or not rows[0].get("open") or not rows[0].get("close"):
            return None
        return epoch_ms(day, rows[0]["open"]), epoch_ms(day, rows[0]["close"])

    def rows(self, method, **args):
        try:
            return method(**args).to_dicts()
        except self.no_data_error:
            return []

    def normalize(self, row, option, expiry_close, now_ms):
        try:
            stamp = row["timestamp"]
            if stamp.tzinfo is None:
                return None
            stamp = stamp.astimezone(NY)
            timestamp = int(stamp.timestamp() * 1000)
            strike_milli = Decimal(str(row["strike"])) * 1000
            if strike_milli != strike_milli.to_integral_value():
                return None
            if (row["symbol"], str(row["expiration"]), row["right"].lower(), str(int(strike_milli))) != (
                    option["symbol"], option["expiration"], option["right"], option["strikeMilli"]):
                return None
            bid, ask = micros(row["bid"]), micros(row["ask"])
            size = int(row["bid_size"])
            if int(bid) <= 0 or int(ask) < int(bid) or size <= 0 or size != row["bid_size"]:
                return None
            hours = self.session(stamp.date())
            if hours is None or not hours[0] <= timestamp <= hours[1] or timestamp > now_ms + 1000 or timestamp > expiry_close:
                return None
            return {"symbol": option["symbol"], "expiration": option["expiration"], "right": option["right"],
                    "strikeMilli": option["strikeMilli"], "bidMicros": bid, "askMicros": ask, "bidSize": size,
                    "timestampMs": timestamp, "marketOpenMs": hours[0], "marketCloseMs": hours[1],
                    "expirationCloseMs": expiry_close}
        except (ValueError, TypeError, KeyError, ArithmeticError):
            return None

    @lru_cache(maxsize=256)
    def dates(self, symbol, expiration, strike, right, as_of, refresh_bucket):
        # The vendor updates its date list overnight; include today separately.
        rows = self.rows(self.client.option_list_dates, request_type="quote", symbol=symbol,
                         expiration=date.fromisoformat(expiration), strike=strike, right=right)
        return sorted({date.fromisoformat(str(row["date"])) for row in rows
                       if str(row["date"]) <= str(as_of)} | {as_of}, reverse=True)

    def latest_on_day(self, option, day, expiry_close, now_ms):
        hours = self.session(day)
        if hours is None:
            return None
        end = min(hours[1], now_ms)
        if end <= hours[0]:
            return None
        # Start at the last minute, expanding backwards only if it had no valid bid.
        # Tick history retains the original timestamp, unlike sampled intervals/EOD.
        window = 60_000
        while end >= hours[0]:
            start = max(hours[0], end - window)
            clock = lambda value: datetime.fromtimestamp(value / 1000, NY).time().isoformat(timespec="milliseconds")
            rows = self.rows(self.client.option_history_quote, symbol=option["symbol"],
                             expiration=option["expiration"], strike=option["strike"], right=option["right"],
                             date=day, interval="tick", start_time=clock(start), end_time=clock(end))
            valid = [market for row in rows if (market := self.normalize(row, option, expiry_close, now_ms))]
            if valid:
                return max(valid, key=lambda market: market["timestampMs"])
            if start == hours[0]:
                return None
            end, window = start - 1, window * 5
        return None

    @lru_cache(maxsize=256)
    def archived_day(self, symbol, expiration, strike, strike_milli, right, day, expiry_close):
        option = {"symbol": symbol, "expiration": expiration, "strike": strike,
                  "strikeMilli": strike_milli, "right": right}
        result = self.latest_on_day(option, day, expiry_close, epoch_ms(day, "23:59:59.999"))
        if result is None:
            # Do not cache missing history while the vendor is still publishing it.
            raise NoValidBid()
        return result

    def quote(self, option, now=None):
        now = now or datetime.now(NY)
        now = now.astimezone(NY)
        now_ms = int(now.timestamp() * 1000)
        expiry = self.session(date.fromisoformat(option["expiration"]))
        if expiry is None or now_ms >= expiry[1]:
            raise NoValidBid()
        rows = self.rows(self.client.option_snapshot_quote, symbol=option["symbol"], expiration=option["expiration"],
                         strike=option["strike"], right=option["right"])
        valid = [market for row in rows if (market := self.normalize(row, option, expiry[1], now_ms))]
        if valid:
            return max(valid, key=lambda market: market["timestampMs"])
        # Snapshots reset at midnight ET. Query the same contract's available history.
        for day in self.dates(option["symbol"], option["expiration"], option["strike"], option["right"], now.date(), now_ms // 60000):
            if day < now.date():
                try:
                    market = self.archived_day(option["symbol"], option["expiration"], option["strike"],
                                               option["strikeMilli"], option["right"], day, expiry[1])
                except NoValidBid:
                    market = None
            else:
                market = self.latest_on_day(option, day, expiry[1], now_ms)
            if market:
                return market
        raise NoValidBid()
