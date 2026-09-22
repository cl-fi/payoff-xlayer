import sys
import unittest
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "theta"))
from market_data import MarketData, NoValidBid, NY

OPTION = {"symbol": "NVDA", "expiration": "2026-09-25", "right": "put", "strike": "220.000", "strikeMilli": "220000"}
FRIDAY = datetime(2026, 9, 18, 15, 59, 59, 900000, tzinfo=NY)
SUNDAY = datetime(2026, 9, 20, 12, tzinfo=NY)
ROW = {"symbol": "NVDA", "expiration": date(2026, 9, 25), "right": "PUT", "strike": 220,
       "bid": 1.11, "ask": 1.12, "bid_size": 4, "timestamp": FRIDAY}


class Frame:
    def __init__(self, rows): self.rows = rows
    def to_dicts(self): return self.rows


class Client:
    def __init__(self):
        self.snapshot = []
        self.history = [ROW]
        self.history_calls = []
    def calendar_on_date(self, date):
        return Frame([{"type": "weekend", "open": None, "close": None} if date.weekday() >= 5 else {"type": "open", "open": "09:30:00", "close": "16:00:00"}])
    def option_snapshot_quote(self, **args): return Frame(self.snapshot)
    def option_list_dates(self, **args): return Frame([{"date": date(2026, 9, 18)}])
    def option_history_quote(self, **args):
        self.history_calls.append(args)
        return Frame(self.history)


class MarketDataTests(unittest.TestCase):
    def test_weekend_cold_start_loads_same_contract_final_valid_bid(self):
        client = Client()
        client.history = [dict(ROW, bid=0, timestamp=FRIDAY.replace(microsecond=950000)), ROW,
                          dict(ROW, right="CALL", bid=9), dict(ROW, strike=225, bid=9)]
        result = MarketData(client).quote(OPTION, SUNDAY)
        self.assertEqual(result["bidMicros"], "1110000")
        self.assertEqual(result["timestampMs"], int(FRIDAY.timestamp() * 1000))
        self.assertEqual(client.history_calls[0]["interval"], "tick")
        self.assertEqual(client.history_calls[0]["date"], FRIDAY.date())
        self.assertEqual(client.history_calls[0]["strike"], OPTION["strike"])

    def test_stale_snapshot_is_used_without_rewriting_time(self):
        client = Client()
        client.snapshot = [ROW]
        result = MarketData(client).quote(OPTION, SUNDAY)
        self.assertEqual(result["timestampMs"], int(FRIDAY.timestamp() * 1000))
        self.assertEqual(client.history_calls, [])

    def test_missing_invalid_and_expired_contracts_never_invent_a_bid(self):
        client = Client()
        client.snapshot = [dict(ROW, timestamp=FRIDAY.replace(tzinfo=None))]
        client.history = [dict(ROW, bid=0), dict(ROW, bid_size=0), dict(ROW, ask=1.0), dict(ROW, bid=float('nan'))]
        data = MarketData(client)
        with self.assertRaises(NoValidBid): data.quote(OPTION, SUNDAY)
        with self.assertRaises(NoValidBid): data.quote(OPTION, datetime(2026, 9, 26, 12, tzinfo=NY))

    def test_new_live_snapshot_replaces_reference_on_reopening(self):
        client = Client()
        data = MarketData(client)
        self.assertEqual(data.quote(OPTION, SUNDAY)["bidMicros"], "1110000")
        monday = datetime(2026, 9, 21, 10, tzinfo=NY)
        client.snapshot = [dict(ROW, bid=1.15, ask=1.17, timestamp=monday)]
        result = data.quote(OPTION, monday)
        self.assertEqual(result["bidMicros"], "1150000")
        self.assertEqual(result["timestampMs"], int(monday.timestamp() * 1000))


if __name__ == '__main__': unittest.main()
