"""
WhaleMind MCP - Flask API server.

Production-oriented: timeouts, validation, caching, consistent error JSON.
Endpoints:
  GET  /health           - Health check
  POST /analyze          - Analyze wallet behavior (fetch → analyze → save → return verdict)
  GET  /wallet/<address> - Fetch data and behavior for a wallet
  GET  /wallet/<address>/balance - Balance only
"""

import os
import re
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request
from psycopg2.extras import Json

from dotenv import load_dotenv

import db
import data_fetch
import behavior
import intelligence
from config import get_logger, setup_logging

load_dotenv()
logger = get_logger(__name__)

# Warn if required env vars are missing (app still runs)
if not os.getenv("ETHERSCAN_API_KEY"):
    logger.warning("ETHERSCAN_API_KEY not set. Etherscan rate limits will be lower.")
if not os.getenv("DATABASE_URL"):
    logger.warning("DATABASE_URL not set. DB features will be disabled.")

app = Flask(__name__)

# --- Config: clean JSON and timeouts ---
# Sort keys so response field order is consistent
app.config["JSON_SORT_KEYS"] = True
# Pretty-print in development for readability
app.config["JSONIFY_PRETTY_PRINT_REGULAR"] = os.getenv("FLASK_DEBUG", "0") == "1"

# Max transactions to fetch for /analyze (keeps response time under 60s)
ANALYZE_TX_LIMIT = 100

# Valid Ethereum address: 0x + 40 hex chars
WALLET_PATTERN = re.compile(r"^0x[a-fA-F0-9]{40}$")
WALLET_MAX_LEN = 42

# Cache: avoid repeated Etherscan calls for the same wallet (TTL in seconds)
ANALYZE_CACHE_TTL = int(os.getenv("ANALYZE_CACHE_TTL", "300"))  # 5 minutes
# GET /wallet/<address>: return cached intelligence if last_updated within this many hours
WALLET_CACHE_TTL_HOURS = 24
DATA_SOURCE = "WhaleMind MCP"
_analyze_cache = {}  # key: wallet (lower), value: { "result": {...}, "cached_at": ts }


def _error_response(message: str, code: str = "ERROR", status: int = 400):
    """Return graceful JSON error. Consistent structure for AI agents."""
    return jsonify({"error": message, "code": code}), status


def _validate_wallet(wallet):
    """
    Validate wallet address. Returns (True, None) if valid,
    or (False, error_message) if invalid.
    """
    if not wallet or not isinstance(wallet, str):
        return False, "Missing or invalid wallet"
    wallet = wallet.strip()
    if len(wallet) > WALLET_MAX_LEN:
        return False, "Wallet address too long"
    if not WALLET_PATTERN.match(wallet):
        return False, "Invalid wallet: must be 0x followed by 40 hex characters"
    return True, None


def _format_ai_response(address: str, verdict: str, confidence: float, entity_type: str, summary: str, last_updated: str) -> dict:
    """Minimal AI-agent consumable response."""
    return {
        "address": address,
        "verdict": verdict,
        "confidence": round(float(confidence), 2),
        "entity_type": entity_type,
        "summary": summary,
        "last_updated": last_updated,
        "data_source": DATA_SOURCE,
    }


def _last_updated_iso(row: dict) -> str:
    """Get last_updated from cache row as ISO string."""
    lu = row.get("last_updated")
    if isinstance(lu, str):
        return lu
    if lu is not None:
        return lu.isoformat()
    return datetime.now(timezone.utc).isoformat()


def _row_to_ai_response(row: dict) -> dict:
    """Build AI response dict from wallet_intelligence row."""
    return _format_ai_response(
        address=row["address"],
        verdict=row["verdict"],
        confidence=float(row["confidence"]),
        entity_type=row["entity_type"],
        summary=row["summary"] or "",
        last_updated=_last_updated_iso(row),
    )


def _get_cached_analyze(wallet):
    """Return cached analyze result: DB first, then in-memory. None on miss."""
    try:
        row = db.get_wallet_intelligence_cache(wallet, max_age_seconds=ANALYZE_CACHE_TTL)
    except Exception as e:
        logger.warning("Cache lookup failed for %s: %s", wallet, e)
        row = None
    if row:
        return _row_to_ai_response(row)
    key = wallet.lower()
    entry = _analyze_cache.get(key)
    if not entry or (time.time() - entry["cached_at"] > ANALYZE_CACHE_TTL):
        if key in _analyze_cache:
            del _analyze_cache[key]
        return None
    return entry["result"]


def _set_cached_analyze(wallet, ai_response: dict, metrics_used: dict | None = None):
    """Store result in DB and in-memory cache. In-memory always updated."""
    _analyze_cache[wallet.lower()] = {"result": ai_response, "cached_at": time.time()}
    try:
        db.save_wallet_intelligence_cache(
            address=ai_response["address"],
            verdict=ai_response["verdict"],
            confidence=ai_response["confidence"],
            entity_type=ai_response["entity_type"],
            behavior_json=metrics_used,
            summary=ai_response["summary"],
        )
    except Exception as e:
        logger.warning("Cache save failed for %s: %s", wallet, e)


def _is_cache_fresh(last_updated, max_hours: int = WALLET_CACHE_TTL_HOURS) -> bool:
    """True if last_updated is within max_hours of now (UTC)."""
    if last_updated is None:
        return False
    if isinstance(last_updated, str):
        try:
            last_dt = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return False
    else:
        last_dt = last_updated
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    return last_dt >= datetime.now(timezone.utc) - timedelta(hours=max_hours)


def _wallet_analysis_from_cache(address: str) -> dict | None:
    """Return cached wallet intelligence if fresh (< 24h). None on miss or stale."""
    try:
        row = db.get_wallet_intelligence_cache(address, max_age_seconds=None)
    except Exception as e:
        logger.warning("Cache lookup failed for %s: %s", address, e)
        return None
    if not row or not _is_cache_fresh(row.get("last_updated")):
        return None
    metrics = row.get("behavior_json") or {}
    return {
        "address": row["address"],
        "cached": True,
        "verdict": row["verdict"],
        "confidence": float(row["confidence"]),
        "entity_inference": row["entity_type"],
        "behavior_summary": row["summary"] or "",
        "transactions_count": metrics.get("total_txs", 0),
        "behavior": metrics,
    }


VERDICT_TO_BEHAVIOR = {
    "SMART_MONEY_ACCUMULATION": "accumulation",
    "STEALTH_DISTRIBUTION": "distribution",
    "EXCHANGE_ROTATION": "exchange_rotation",
    "WHALE_DORMANT": "dormant",
    "NEUTRAL": "neutral",
}


def _verdict_to_behavior(verdict):
    """Map intelligence verdict to short behavior label for DB."""
    return VERDICT_TO_BEHAVIOR.get(verdict, "neutral")


def _persist_wallet_transactions(conn, address: str, transactions: list, limit: int):
    """Upsert wallet and insert transactions. Caller must commit/rollback/close."""
    with db.get_cursor(conn) as cur:
        cur.execute(
            "INSERT INTO wallets (address, last_seen_at) VALUES (%s, NOW()) "
            "ON CONFLICT (address) DO UPDATE SET last_seen_at = NOW();",
            (address,),
        )
        for tx in transactions[:limit]:
            row = data_fetch.normalize_tx_for_db(tx)
            try:
                ts = int(row.get("timestamp")) if row.get("timestamp") is not None else 0
            except (TypeError, ValueError):
                ts = 0
            cur.execute(
                """
                INSERT INTO transactions
                (wallet_address, tx_hash, from_address, to_address, value_wei, block_number, timestamp, raw_data)
                VALUES (%(wallet_address)s, %(tx_hash)s, %(from_address)s, %(to_address)s,
                        %(value_wei)s, %(block_number)s, to_timestamp(%(ts)s), %(raw_data)s)
                ON CONFLICT (tx_hash) DO NOTHING;
                """,
                {**row, "ts": ts, "raw_data": Json(row.get("raw_data") or {})},
            )


@app.route("/health", methods=["GET"])
def health():
    """Health check: returns 200 and status."""
    return jsonify({"status": "ok", "service": "WhaleMind MCP"})


@app.route("/analyze", methods=["POST"])
def analyze():
    """
    Analyze a wallet: fetch transactions → analyze behavior → save to DB → return verdict.
    Uses cache to avoid repeated API calls for the same wallet within TTL.
    Request body (JSON): { "wallet": "0x..." }
    Response: { wallet, behavior, confidence, verdict, interpretation }
    """
    # 1) Input validation: require JSON body with wallet
    if not request.is_json:
        return _error_response("Content-Type must be application/json", "INVALID_INPUT", 400)
    body = request.get_json(silent=True)
    if body is None:
        return _error_response("Invalid JSON body", "INVALID_JSON", 400)
    if not isinstance(body, dict):
        return _error_response("Body must be a JSON object", "INVALID_INPUT", 400)

    wallet = body.get("wallet")
    ok, err = _validate_wallet(wallet)
    if not ok:
        return _error_response(err, "VALIDATION_ERROR", 400)

    wallet = wallet.strip()

    # 2) Return cached result if available (avoids repeated Etherscan calls)
    cached = _get_cached_analyze(wallet)
    if cached is not None:
        return jsonify(cached)

    try:
        transactions = data_fetch.fetch_transactions(wallet, limit=ANALYZE_TX_LIMIT)
        result = intelligence.classify_wallet(transactions, wallet, include_metrics=True)
        verdict, confidence = result["verdict"], result["confidence"]
        entity_type = result.get("entity_type") or result["entity_inference"]

        db.save_wallet_intel(wallet, _verdict_to_behavior(verdict), confidence, verdict)

        ai_response = _format_ai_response(
            result["address"], verdict, confidence, entity_type,
            result["behavior_summary"], datetime.now(timezone.utc).isoformat(),
        )
        _set_cached_analyze(wallet, ai_response, result.get("metrics_used"))
        return jsonify(ai_response)
    except Exception as e:
        logger.exception("Analyze failed for %s: %s", wallet, e)
        return _error_response(
            "Analysis failed. Please try again later.",
            "ANALYSIS_ERROR",
            500,
        )


@app.route("/wallet/<address>/balance", methods=["GET"])
def wallet_balance(address):
    """Get ETH balance for an address (in wei as string)."""
    ok, err = _validate_wallet(address)
    if not ok:
        return _error_response(err, "VALIDATION_ERROR", 400)
    try:
        balance_wei = data_fetch.fetch_balance(address)
    except Exception as e:
        logger.warning("Balance fetch failed for %s: %s", address, e)
        return _error_response("Failed to fetch balance", "UPSTREAM_ERROR", 502)
    if balance_wei is None:
        return _error_response("Failed to fetch balance (timeout or upstream error)", "UPSTREAM_ERROR", 502)
    return jsonify({"address": address, "balance_wei": balance_wei})


@app.route("/wallet/<address>", methods=["GET"])
def wallet_analysis(address):
    """
    Fetch transactions for the given address, optionally save to DB,
    and return behavior analysis.
    Returns cached wallet_intelligence if last_updated < 24h ago (avoids Etherscan).
    """
    ok, err = _validate_wallet(address)
    if not ok:
        return _error_response(err, "VALIDATION_ERROR", 400)

    # Check wallet_intelligence cache before Etherscan (24h TTL, datetime comparison)
    try:
        cached = _wallet_analysis_from_cache(address)
        if cached is not None:
            return jsonify(cached)
    except Exception as e:
        logger.warning("Cache lookup failed for /wallet/%s: %s", address, e)

    # Validate limit: 1–1000
    try:
        limit = request.args.get("limit", 100, type=int)
    except (TypeError, ValueError):
        limit = 100
    limit = min(max(limit, 1), 1000)

    # Fetch from chain
    try:
        transactions = data_fetch.fetch_transactions(address, limit=limit)
    except Exception as e:
        logger.warning("Transactions fetch failed for %s: %s", address, e)
        return _error_response("Failed to fetch transactions", "UPSTREAM_ERROR", 502)
    if not transactions and limit > 0:
        return jsonify({
            "address": address,
            "transactions": [],
            "behavior": behavior.analyze_transactions([], address),
            "message": "No transactions found or API error.",
        }), 200

    # Analyze behavior
    behavior_result = behavior.summarize_behavior(transactions, wallet_address=address)

    conn = db.get_connection()
    if conn:
        try:
            _persist_wallet_transactions(conn, address, transactions, limit)
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.warning("DB persist failed for %s: %s", address, e)
        finally:
            db.close_connection(conn)

    return jsonify({
        "address": address,
        "transactions_count": len(transactions),
        "behavior": behavior_result,
    })


# --- Global error handlers: consistent JSON for all errors ---
@app.errorhandler(404)
def not_found(e):
    return _error_response("Not found", "NOT_FOUND", 404)


@app.errorhandler(405)
def method_not_allowed(e):
    return _error_response("Method not allowed", "METHOD_NOT_ALLOWED", 405)


@app.errorhandler(500)
def internal_error(e):
    logger.exception("Unhandled server error: %s", e)
    return _error_response("Internal server error", "INTERNAL_ERROR", 500)


def main():
    """Run the Flask app."""
    setup_logging()
    try:
        db.init_db()
    except Exception as e:
        logger.warning("DB init failed at startup: %s. API will run without DB.", e)

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    # Disable reloader when debugging on Windows to avoid WinError 10038 (socket/reloader conflict)
    use_reloader = debug and os.name != "nt"
    app.run(host=host, port=port, debug=debug, use_reloader=use_reloader)


if __name__ == "__main__":
    main()
