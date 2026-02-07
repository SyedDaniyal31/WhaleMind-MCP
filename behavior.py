"""
WhaleMind MCP - Wallet behavior analysis.

Analyzes transaction history to derive simple behavior metrics
(e.g. activity level, big transfers).
"""

from datetime import datetime
from decimal import Decimal

# 1 ETH in wei (for human-readable comparisons)
WEI_PER_ETH = 10**18


def wei_to_eth(wei_str):
    """Convert wei (string) to ETH (float). Returns 0.0 if invalid."""
    try:
        return float(Decimal(wei_str) / WEI_PER_ETH)
    except (TypeError, ValueError, Decimal.InvalidOperation):
        return 0.0


def analyze_transactions(transactions, wallet_address=None):
    """
    Analyze a list of transactions and return behavior metrics.

    Args:
        transactions: List of tx dicts (Etherscan-style: from, to, value, timeStamp, etc.).
        wallet_address: Optional. If set, we treat this as the "wallet" and count in/out.

    Returns:
        Dict with: total_txs, total_in_eth, total_out_eth, unique_counterparties,
        first_seen, last_seen, large_transfers_count.
    """
    total_in_eth = 0.0
    total_out_eth = 0.0
    counterparties = set()
    large_transfers = 0
    timestamps = []

    for tx in transactions:
        from_addr = (tx.get("from") or "").lower()
        to_addr = (tx.get("to") or "").lower()
        value_wei = tx.get("value") or "0"
        value_eth = wei_to_eth(value_wei)
        ts = tx.get("timeStamp")
        if ts:
            try:
                timestamps.append(int(ts))
            except (TypeError, ValueError):
                pass

        # If we're analyzing for a specific wallet, count in/out relative to it
        if wallet_address:
            addr_lower = wallet_address.lower()
            if from_addr == addr_lower:
                total_out_eth += value_eth
                if to_addr:
                    counterparties.add(to_addr)
            if to_addr == addr_lower:
                total_in_eth += value_eth
                if from_addr:
                    counterparties.add(from_addr)
        else:
            # No specific wallet: just sum all movement and count unique addresses
            total_out_eth += value_eth
            if from_addr:
                counterparties.add(from_addr)
            if to_addr:
                counterparties.add(to_addr)

        # Count "large" transfers (e.g. >= 10 ETH)
        if value_eth >= 10.0:
            large_transfers += 1

    first_seen = min(timestamps) if timestamps else None
    last_seen = max(timestamps) if timestamps else None

    return {
        "total_txs": len(transactions),
        "total_in_eth": round(total_in_eth, 4),
        "total_out_eth": round(total_out_eth, 4),
        "unique_counterparties": len(counterparties),
        "first_seen": first_seen,
        "last_seen": last_seen,
        "large_transfers_count": large_transfers,
    }


def summarize_behavior(transactions, wallet_address=None):
    """
    Same as analyze_transactions but with optional human-readable timestamps.

    Returns the same dict plus first_seen_iso, last_seen_iso when timestamps exist.
    """
    result = analyze_transactions(transactions, wallet_address)
    for key, ts in [("first_seen", result.get("first_seen")), ("last_seen", result.get("last_seen"))]:
        if ts is not None:
            try:
                result[f"{key}_iso"] = datetime.utcfromtimestamp(int(ts)).isoformat() + "Z"
            except (TypeError, ValueError, OSError):
                result[f"{key}_iso"] = None
        else:
            result[f"{key}_iso"] = None
    return result


# --- Behavior verdict (accumulation / distribution / neutral) ---

# Threshold in ETH: net inflow or outflow must exceed this to be non-neutral
BEHAVIOR_ETH_THRESHOLD = 50.0

# Verdict constants (returned as strings)
VERDICT_ACCUMULATION = "SMART_MONEY_ACCUMULATION"
VERDICT_DISTRIBUTION = "STEALTH_DISTRIBUTION"
VERDICT_NEUTRAL = "NEUTRAL"


def analyze_behavior(transactions, wallet_address):
    """
    Classify wallet behavior as accumulation, distribution, or neutral based on
    net ETH inflow/outflow.

    Logic:
      - Net = total inflow − total outflow (for this wallet).
      - Net inflow > 50 ETH  → accumulation (buying/accumulating).
      - Net outflow > 50 ETH → distribution (selling/distributing).
      - Otherwise            → neutral.

    Args:
        transactions: List of tx dicts (Etherscan-style: from, to, value).
        wallet_address: The wallet we are analyzing (used to compute in/out).

    Returns:
        Dict with:
          - behavior: "accumulation" | "distribution" | "neutral"
          - confidence: float in [0.5, 0.9]
          - verdict: "SMART_MONEY_ACCUMULATION" | "STEALTH_DISTRIBUTION" | "NEUTRAL"
          - net_eth: net inflow (positive) or outflow (negative) in ETH
    """
    # Reuse existing logic to get inflow and outflow for this wallet
    metrics = analyze_transactions(transactions, wallet_address=wallet_address)
    total_in_eth = metrics["total_in_eth"]
    total_out_eth = metrics["total_out_eth"]

    # Net ETH: positive = more received than sent (accumulation), negative = distribution
    net_eth = total_in_eth - total_out_eth

    # Classify behavior
    if net_eth > BEHAVIOR_ETH_THRESHOLD:
        behavior = "accumulation"
        verdict = VERDICT_ACCUMULATION
    elif net_eth < -BEHAVIOR_ETH_THRESHOLD:
        behavior = "distribution"
        verdict = VERDICT_DISTRIBUTION
    else:
        behavior = "neutral"
        verdict = VERDICT_NEUTRAL

    # Confidence score between 0.5 and 0.9
    # Start at 0.5; add up to 0.4 when the signal is strong (net far past threshold)
    confidence = _confidence_score(behavior, net_eth, metrics["total_txs"])

    return {
        "behavior": behavior,
        "confidence": round(confidence, 2),
        "verdict": verdict,
        "net_eth": round(net_eth, 4),
    }


def _confidence_score(behavior, net_eth, total_txs):
    """
    Compute a confidence score in [0.5, 0.9].
    Higher when the net amount is well past the 50 ETH threshold or we have more data.
    """
    base = 0.5
    extra = 0.4  # so max is 0.9

    if behavior == "neutral":
        # Slight boost if we have enough transactions to trust "neutral"
        if total_txs >= 10:
            return base + 0.1
        return base

    # How far past the 50 ETH threshold (in ETH)
    excess = abs(net_eth) - BEHAVIOR_ETH_THRESHOLD
    if excess <= 0:
        return base

    # Map excess to [0, 0.4]: e.g. 200 ETH excess → full 0.4
    strength = min(1.0, excess / 200.0)
    return base + extra * strength
