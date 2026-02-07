"""
Simple test script for the local WhaleMind API.

Usage:
  python test_api.py [wallet_address]

  If no address is given, uses a sample Ethereum address.
  Ensure the API is running (e.g. python api.py) before running this script.
"""

import json
import sys
import requests

# Local API base URL (change if you run on a different host/port)
API_BASE = "http://127.0.0.1:5000"

# Sample address (Ethereum Foundation) if none provided
DEFAULT_WALLET = "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe"


def main():
    wallet = sys.argv[1].strip() if len(sys.argv) > 1 else DEFAULT_WALLET

    print(f"Calling WhaleMind API for wallet: {wallet}")
    print("-" * 50)

    try:
        # POST /analyze with JSON body
        resp = requests.post(
            f"{API_BASE}/analyze",
            json={"wallet": wallet},
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
    except requests.exceptions.ConnectionError:
        print("Error: Could not connect to the API. Is it running? (e.g. python api.py)")
        sys.exit(1)
    except requests.exceptions.Timeout:
        print("Error: Request timed out.")
        sys.exit(1)

    print(f"Status: {resp.status_code}")
    print()

    try:
        data = resp.json()
    except json.JSONDecodeError:
        print("Response (raw):", resp.text)
        sys.exit(1)

    if not resp.ok:
        print("Error response:", json.dumps(data, indent=2))
        sys.exit(1)

    # Pretty-print the result
    print("Result:")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
