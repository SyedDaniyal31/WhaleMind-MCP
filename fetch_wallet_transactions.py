"""
Fetch normal ETH transactions for a wallet using the Etherscan API.

Run from command line:
  python fetch_wallet_transactions.py <wallet_address>

Or import and use:
  from fetch_wallet_transactions import get_transactions
  data = get_transactions("0x...")
"""

import json
import os
import sys
import requests
from dotenv import load_dotenv

# Load variables from .env (e.g. ETHERSCAN_API_KEY)
load_dotenv()

# Etherscan V2 API (Ethereum mainnet)
ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api"
CHAIN_ID = 1

# How many transactions to fetch per request (max 10000 for Etherscan)
DEFAULT_LIMIT = 100


def get_transactions(wallet_address):
    """
    Fetch the last 100 normal (ETH) transactions for a wallet.

    Args:
        wallet_address: Ethereum address (must start with 0x).

    Returns:
        JSON-serializable dict with keys:
          - "ok": bool, True if the request succeeded
          - "message": str, short description (e.g. "Success" or error message)
          - "count": int, number of transactions returned
          - "transactions": list of transaction objects from Etherscan

    Errors (network, invalid key, invalid address) are caught; "ok" will be
    False and "message" / "transactions" will describe or be empty.
    """
    # Build request parameters (Etherscan V2 "txlist" = normal transfers)
    api_key = os.getenv("ETHERSCAN_API_KEY", "")
    params = {
        "chainid": CHAIN_ID,
        "module": "account",
        "action": "txlist",
        "address": wallet_address,
        "startblock": 0,
        "endblock": 99999999,
        "page": 1,
        "offset": DEFAULT_LIMIT,
        "sort": "desc",
        "apikey": api_key,
    }

    try:
        response = requests.get(ETHERSCAN_API_URL, params=params, timeout=30)
        response.raise_for_status()  # Raise if HTTP status is 4xx or 5xx
    except requests.exceptions.Timeout:
        return {
            "ok": False,
            "message": "Request timed out. Try again later.",
            "count": 0,
            "transactions": [],
        }
    except requests.exceptions.RequestException as e:
        return {
            "ok": False,
            "message": f"Network error: {str(e)}",
            "count": 0,
            "transactions": [],
        }

    # Parse JSON body
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            "ok": False,
            "message": "Invalid JSON in API response.",
            "count": 0,
            "transactions": [],
        }

    # Etherscan returns status "1" and message "OK" on success
    if data.get("status") == "1" and data.get("message") == "OK":
        result = data.get("result")
        if not isinstance(result, list):
            result = []
        return {
            "ok": True,
            "message": "Success",
            "count": len(result),
            "transactions": result,
        }
    else:
        # API returned an error (e.g. invalid address, rate limit)
        return {
            "ok": False,
            "message": data.get("message", "Unknown API error"),
            "result": data.get("result", data.get("message", "Error")),
            "count": 0,
            "transactions": [],
        }


def main():
    """Run from command line: python fetch_wallet_transactions.py <address>"""
    if len(sys.argv) < 2:
        print("Usage: python fetch_wallet_transactions.py <wallet_address>", file=sys.stderr)
        print("Example: python fetch_wallet_transactions.py 0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe", file=sys.stderr)
        sys.exit(1)

    wallet_address = sys.argv[1].strip()
    if not wallet_address.startswith("0x") or len(wallet_address) != 42:
        print("Error: wallet_address should be 0x followed by 40 hex characters.", file=sys.stderr)
        sys.exit(1)

    result = get_transactions(wallet_address)

    # Output JSON to stdout (so you can pipe to a file or other tools)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
