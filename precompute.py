"""
WhaleMind MCP - Precompute wallet intelligence.

Batch script to analyze a list of wallets and store results in the DB.
Designed to run every 6 hours (e.g. via cron).

Usage:
  python precompute.py                              # use wallets from WALLETS env or wallets.txt
  python precompute.py 0x... 0x...                  # list of addresses
  python precompute.py --file path/to/wallets.txt   # one address per line

Exits 0 on success, 1 on failure. Non-fatal per-wallet errors are logged.
"""

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

import data_fetch
import db
import intelligence
from config import get_logger, setup_logging

load_dotenv()
logger = get_logger(__name__)

# Same limit as API (keeps Etherscan calls bounded)
TX_LIMIT = int(os.getenv("PRECOMPUTE_TX_LIMIT", "100"))

# Valid Ethereum address
WALLET_PATTERN = re.compile(r"^0x[a-fA-F0-9]{40}$")


def _validate_wallet(addr: str) -> bool:
    """Return True if address looks valid."""
    return bool(addr and isinstance(addr, str) and WALLET_PATTERN.match(addr.strip()))


def _analyze_and_save(wallet: str) -> tuple[bool, str]:
    """
    Fetch transactions, run intelligence classification, save to DB.
    Returns (success, message). Never raises; logs and returns (False, msg) on error.
    """
    wallet = wallet.strip()
    if not _validate_wallet(wallet):
        return False, f"Invalid address: {wallet}"

    try:
        transactions = data_fetch.fetch_transactions(wallet, limit=TX_LIMIT)
    except Exception as e:
        logger.warning("Etherscan fetch failed for %s: %s", wallet, e)
        return False, f"Etherscan fetch failed: {wallet}"

    try:
        result = intelligence.classify_wallet(transactions, wallet, include_metrics=True)
    except Exception as e:
        logger.warning("Classification failed for %s: %s", wallet, e)
        return False, f"Classification failed: {wallet}"

    verdict = result["verdict"]
    confidence = result["confidence"]
    entity_type = result.get("entity_type") or result["entity_inference"]
    summary = result["behavior_summary"]
    metrics = result.get("metrics_used")

    ok = db.save_wallet_intelligence_cache(
        address=wallet,
        verdict=verdict,
        confidence=confidence,
        entity_type=entity_type,
        behavior_json=metrics,
        summary=summary,
    )
    if not ok:
        return False, f"DB save failed: {wallet}"

    # Also update whale_intel for consistency (non-fatal)
    try:
        behavior_label = _verdict_to_behavior(verdict)
        db.save_wallet_intel(wallet, behavior_label, confidence, verdict)
    except Exception as e:
        logger.warning("whale_intel save failed for %s: %s", wallet, e)

    return True, f"{wallet} -> {verdict} ({confidence})"


def _verdict_to_behavior(verdict: str) -> str:
    """Map verdict to short behavior label."""
    m = {
        "SMART_MONEY_ACCUMULATION": "accumulation",
        "STEALTH_DISTRIBUTION": "distribution",
        "EXCHANGE_ROTATION": "exchange_rotation",
        "WHALE_DORMANT": "dormant",
        "NEUTRAL": "neutral",
    }
    return m.get(verdict, "neutral")


def _load_wallets_from_file(path: str | Path) -> list[str]:
    """Load addresses from file, one per line. Skips empty and invalid."""
    path = Path(path)
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("Could not read wallet file %s: %s", path, e)
        return []
    addresses = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and _validate_wallet(line):
            addresses.append(line.strip())
    return addresses


def _load_wallets_from_env() -> list[str]:
    """Load addresses from WALLETS env (comma- or newline-separated)."""
    raw = os.getenv("WALLETS", "").strip()
    if not raw:
        return []
    addresses = []
    for part in re.split(r"[\s,]+", raw):
        part = part.strip()
        if part and _validate_wallet(part):
            addresses.append(part)
    return addresses


def main() -> int:
    parser = argparse.ArgumentParser(description="Precompute wallet intelligence for WhaleMind MCP.")
    parser.add_argument(
        "addresses",
        nargs="*",
        help="Wallet addresses to analyze",
    )
    parser.add_argument(
        "--file", "-f",
        metavar="PATH",
        help="Path to file with one address per line",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress per-wallet output",
    )
    args = parser.parse_args()

    wallets: list[str] = []
    if args.addresses:
        wallets = [a for a in args.addresses if _validate_wallet(a)]
    elif args.file:
        wallets = _load_wallets_from_file(args.file)
        if not wallets:
            logger.error("No valid addresses in %s", args.file)
            return 1
    else:
        # Try env, then default wallets.txt in project root
        wallets = _load_wallets_from_env()
        if not wallets:
            default_path = Path(__file__).parent / "wallets.txt"
            wallets = _load_wallets_from_file(default_path)

    if not wallets:
        logger.error("No wallets to process. Provide addresses, --file, or set WALLETS env.")
        return 1

    setup_logging()
    # Ensure DB tables exist
    try:
        db.init_db()
    except Exception as e:
        logger.warning("DB init failed: %s. Will attempt saves.", e)
    if not db.DATABASE_URL:
        logger.error("DATABASE_URL not set. Cannot store results.")
        return 1

    logger.info("Precompute: %d wallet(s)", len(wallets))
    ok_count = 0
    fail_count = 0

    for i, wallet in enumerate(wallets, 1):
        try:
            success, msg = _analyze_and_save(wallet)
            if success:
                ok_count += 1
                if not args.quiet:
                    print(f"  [{i}/{len(wallets)}] {msg}")
            else:
                fail_count += 1
                print(f"  [{i}/{len(wallets)}] FAIL: {msg}", file=sys.stderr)
        except Exception as e:
            fail_count += 1
            logger.exception("Wallet %s failed: %s", wallet, e)

    logger.info("Precompute done: %d ok, %d failed", ok_count, fail_count)
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
