"""
WhaleMind MCP - Database connection module.

Handles PostgreSQL connection and basic setup.
Uses python-dotenv for DATABASE_URL from .env.
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor, Json
from dotenv import load_dotenv

from config import get_logger

load_dotenv()
logger = get_logger(__name__)

# Connection URL from environment (e.g. postgresql://user:pass@localhost:5432/whalemind)
_raw_url = os.getenv("DATABASE_URL")

# Only use if it looks like a real PostgreSQL URL (avoids "invalid connection option" when
# DATABASE_URL is a placeholder like the literal string "DATABASE_URL")
DATABASE_URL = None
if _raw_url and isinstance(_raw_url, str) and _raw_url.strip().lower().startswith(("postgresql://", "postgres://")):
    DATABASE_URL = _raw_url.strip()


def get_connection():
    """
    Open a new database connection.
    Returns a connection object, or None if DATABASE_URL is missing/invalid or connection fails.
    """
    if not DATABASE_URL:
        return None
    try:
        return psycopg2.connect(DATABASE_URL)
    except psycopg2.OperationalError as e:
        logger.warning("Could not connect to PostgreSQL: %s. API will run without DB.", e)
        return None
    except psycopg2.ProgrammingError as e:
        logger.warning("Invalid DATABASE_URL: %s. Use postgresql://user:password@host:port/db", e)
        return None


def get_cursor(connection, dict_cursor=True):
    """
    Get a cursor for the given connection.
    If dict_cursor is True, rows are returned as dictionaries (easier to use).
    """
    if dict_cursor:
        return connection.cursor(cursor_factory=RealDictCursor)
    return connection.cursor()


def init_db():
    """
    Create tables if they don't exist.
    Call this once when setting up the project or on first run.
    """
    conn = get_connection()
    if not conn:
        if not DATABASE_URL:
            logger.warning("DATABASE_URL not set. Skipping DB init.")
        return
    try:
        with conn.cursor() as cur:
            # Wallets we've seen (address, first/last seen, metadata)
            cur.execute("""
            CREATE TABLE IF NOT EXISTS wallets (
                id SERIAL PRIMARY KEY,
                address VARCHAR(42) UNIQUE NOT NULL,
                first_seen_at TIMESTAMPTZ DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ DEFAULT NOW(),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            """)
            # Raw transaction data from chain (for analysis)
            cur.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                wallet_address VARCHAR(42) NOT NULL,
                tx_hash VARCHAR(66) UNIQUE,
                from_address VARCHAR(42),
                to_address VARCHAR(42),
                value_wei VARCHAR(78),
                block_number BIGINT,
                timestamp TIMESTAMPTZ,
                raw_data JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            """)
            # Index for fast lookups by wallet
            cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_transactions_wallet
            ON transactions(wallet_address);
            """)
            # Whale intel: behavior analysis results per wallet
            cur.execute("""
            CREATE TABLE IF NOT EXISTS whale_intel (
                wallet VARCHAR(42) PRIMARY KEY,
                behavior VARCHAR(32) NOT NULL,
                confidence REAL NOT NULL,
                verdict VARCHAR(64) NOT NULL,
                last_updated TIMESTAMPTZ DEFAULT NOW()
            );
            """)
            # Wallet intelligence cache: full classification results for API responses
            cur.execute("""
            CREATE TABLE IF NOT EXISTS wallet_intelligence (
                address TEXT PRIMARY KEY,
                verdict TEXT NOT NULL,
                confidence FLOAT NOT NULL,
                entity_type TEXT NOT NULL,
                behavior_json JSONB,
                summary TEXT,
                last_updated TIMESTAMPTZ DEFAULT NOW()
            );
            """)
        conn.commit()
        logger.info("DB init: tables created or already exist.")
    except (psycopg2.Error, Exception) as e:
        logger.error("DB init failed: %s", e)
        if conn:
            conn.rollback()
    finally:
        close_connection(conn)


def close_connection(connection):
    """Safely close a database connection."""
    if connection and not connection.closed:
        connection.close()


def _with_connection(callback):
    """Get connection, run callback(conn), commit on success, rollback and return None on error. Returns callback return value or None."""
    if not DATABASE_URL:
        return None
    conn = None
    try:
        conn = get_connection()
        if not conn:
            return None
        out = callback(conn)
        conn.commit()
        return out
    except (psycopg2.Error, Exception) as e:
        if conn:
            conn.rollback()
        raise
    finally:
        close_connection(conn)


def save_wallet_intel(wallet, behavior, confidence, verdict):
    """UPSERT whale_intel row. Returns True on success, False otherwise (no raise)."""
    def _do(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO whale_intel (wallet, behavior, confidence, verdict, last_updated)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (wallet) DO UPDATE SET
                    behavior = EXCLUDED.behavior,
                    confidence = EXCLUDED.confidence,
                    verdict = EXCLUDED.verdict,
                    last_updated = NOW();
                """,
                (wallet, behavior, confidence, verdict),
            )
        return True
    try:
        return _with_connection(_do) is True
    except Exception as e:
        logger.warning("save_wallet_intel failed for %s: %s", wallet, e)
        return False


_SELECT_INTEL = (
    "SELECT address, verdict, confidence, entity_type, behavior_json, summary, last_updated "
    "FROM wallet_intelligence WHERE address = %s"
)


def get_wallet_intelligence_cache(address: str, max_age_seconds: int | None = None):
    """Return cached row or None. If max_age_seconds set, only return if last_updated within that window."""
    if not DATABASE_URL:
        return None
    conn = None
    try:
        conn = get_connection()
        if not conn:
            return None
        with get_cursor(conn) as cur:
            if max_age_seconds is not None:
                cur.execute(_SELECT_INTEL + " AND last_updated > NOW() - INTERVAL '1 second' * %s;", (address, max_age_seconds))
            else:
                cur.execute(_SELECT_INTEL + ";", (address,))
            row = cur.fetchone()
        if not row:
            return None
        out = dict(row)
        if out.get("last_updated") is not None:
            out["last_updated"] = out["last_updated"].isoformat()
        return out
    except (psycopg2.Error, Exception) as e:
        logger.debug("get_wallet_intelligence_cache failed for %s: %s", address, e)
        return None
    finally:
        close_connection(conn)


def save_wallet_intelligence_cache(
    address: str,
    verdict: str,
    confidence: float,
    entity_type: str,
    behavior_json: dict | None = None,
    summary: str | None = None,
) -> bool:
    """UPSERT wallet_intelligence row. Returns True on success, False otherwise."""
    def _do(conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO wallet_intelligence
                    (address, verdict, confidence, entity_type, behavior_json, summary, last_updated)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (address) DO UPDATE SET
                    verdict = EXCLUDED.verdict,
                    confidence = EXCLUDED.confidence,
                    entity_type = EXCLUDED.entity_type,
                    behavior_json = EXCLUDED.behavior_json,
                    summary = EXCLUDED.summary,
                    last_updated = NOW();
                """,
                (address, verdict, confidence, entity_type, Json(behavior_json) if behavior_json else None, summary),
            )
        return True
    try:
        return _with_connection(_do) is True
    except Exception as e:
        logger.warning("save_wallet_intelligence_cache failed for %s: %s", address, e)
        return False
