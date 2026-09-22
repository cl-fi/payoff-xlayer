"""Private stdio adapter to the official ThetaData Python client; no HTTP listener."""
import json
import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from market_data import MarketData, NoValidBid

# The SDK's INFO authentication log includes session credentials. Never emit it.
logging.disable(logging.CRITICAL)
import grpc
from thetadata import ThetaClient
from thetadata.errors import NoDataFoundError

output_lock = threading.Lock()


def emit(value):
    with output_lock:
        print(json.dumps(value, allow_nan=False), flush=True)


def run():
    client = ThetaClient(api_key=os.environ["THETADATA_API_KEY"], dotenv_path="/dev/null")
    data = MarketData(client, NoDataFoundError)

    def handle(message):
        identifier = message["id"]
        try:
            emit({"id": identifier, "market": data.quote(message["option"])})
        except (NoDataFoundError, NoValidBid):
            emit({"id": identifier, "error": "NO_VALID_BID_HISTORY"})
        except grpc.RpcError as error:
            emit({"id": identifier, "error": "MARKET_DATA_UNAVAILABLE"})
            if error.code() == grpc.StatusCode.UNAUTHENTICATED:
                # Reauthenticate in a new worker; no session token reaches logs or Node.
                os._exit(1)
        except Exception:
            # Raw upstream exceptions may include credentials. The parent enforces a timeout
            # and restarts this process if the SDK call hangs.
            emit({"id": identifier, "error": "MARKET_DATA_UNAVAILABLE"})

    emit({"ready": True})
    with ThreadPoolExecutor(max_workers=4) as pool:
        for line in sys.stdin:
            pool.submit(handle, json.loads(line))


if __name__ == "__main__":
    try:
        run()
    except Exception:
        emit({"ready": False})
        sys.exit(1)
