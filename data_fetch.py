"""
WhaleMind MCP - Blockchain data fetching.

Fetches wallet transactions (e.g. from Etherscan-style API)
and optionally stores them via db module.
"""

import os
import requests
from dotenv import load_dotenv

from config import get_logger

load_dotenv()

logger = get_logger(__name__)

# Base URL for Etherscan V2 API (Ethereum mainnet)
ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api"
API_KEY = os.getenv("ETHERSCAN_API_KEY", "")

# Ethereum mainnet
CHAIN_ID = 1

# Timeout for HTTP calls (seconds). Prevents hanging on slow or stuck APIs.
REQUEST_TIMEOUT = int(os.getenv("ETHERSCAN_REQUEST_TIMEOUT", "25"))


def fetch_transactions(address, limit=100):
    """
    Fetch normal transactions for a given wallet address.

    Args:
        address: Ethereum address (0x...).
        limit: Max number of transactions to return (API may cap this).

    Returns:
        List of transaction dicts, or empty list on error.
    """
    params = {
        "chainid": CHAIN_ID,
        "module": "account",
        "action": "txlist",
        "address": address,
        "startblock": 0,
        "endblock": 99999999,
        "page": 1,
        "offset": min(limit, 10000),
        "sort": "desc",
        "apikey": API_KEY,
    }

    try:
        resp = requests.get(ETHERSCAN_API_BASE, params=params, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") != "1" or data.get("message") != "OK":
            logger.debug("Etherscan API error for %s: %s", address, data.get("message", "unknown"))
            return []

        return data.get("result", [])
    except requests.exceptions.Timeout:
        logger.warning("Etherscan request timeout for %s (timeout=%ds)", address, REQUEST_TIMEOUT)
        return []
    except requests.RequestException as e:
        logger.warning("Etherscan request failed for %s: %s", address, e)
        return []
    except (ValueError, KeyError, TypeError) as e:
        logger.warning("Etherscan response parse error for %s: %s", address, e)
        return []


def fetch_balance(address):
    """
    Fetch ETH balance for an address (in wei, as string).

    Returns:
        Balance string in wei, or None on error.
    """
    params = {
        "chainid": CHAIN_ID,
        "module": "account",
        "action": "balance",
        "address": address,
        "tag": "latest",
        "apikey": API_KEY,
    }

    try:
        resp = requests.get(ETHERSCAN_API_BASE, params=params, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "1":
            return data.get("result")
        return None
    except requests.exceptions.Timeout:
        logger.warning("Etherscan balance request timeout for %s", address)
        return None
    except requests.RequestException as e:
        logger.warning("Etherscan balance request failed for %s: %s", address, e)
        return None
    except (ValueError, KeyError, TypeError) as e:
        logger.warning("Etherscan balance response parse error for %s: %s", address, e)
        return None


def normalize_tx_for_db(tx):
    """
    Convert Etherscan-style tx object to our DB-friendly format.

    Args:
        tx: One transaction dict from Etherscan API.

    Returns:
        Dict with keys: wallet_address, tx_hash, from_address, to_address,
        value_wei, block_number, timestamp, raw_data.
    """
    # We consider the wallet as the 'from' or 'to' we're tracking
    return {
        "wallet_address": tx.get("from", ""),
        "tx_hash": tx.get("hash"),
        "from_address": tx.get("from"),
        "to_address": tx.get("to"),
        "value_wei": tx.get("value"),
        "block_number": tx.get("blockNumber"),
        "timestamp": tx.get("timeStamp"),
        "raw_data": tx,
    }
