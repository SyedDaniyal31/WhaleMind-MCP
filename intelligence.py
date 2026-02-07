"""
WhaleMind MCP - Tier-S intelligence layer.

Rule-based classification of wallet behavior into high-value verdicts
for use by AI agents. No ML; tunable thresholds; production-ready.

Scoring dimensions (modular, adjustable):
  • inflow/outflow ratio
  • tx frequency (txs per day)
  • counterparties (unique addresses)
  • large transfers (size and count)
  • recency (recent vs historical activity)

Returns: verdict, confidence (0–1), entity_type, human-readable summary.
"""

from collections import defaultdict
from typing import Any, Callable

import behavior

# -----------------------------------------------------------------------------
# VERDICTS & ENTITY TYPES
# -----------------------------------------------------------------------------

VERDICT_SMART_MONEY_ACCUMULATION = "SMART_MONEY_ACCUMULATION"
VERDICT_STEALTH_DISTRIBUTION = "STEALTH_DISTRIBUTION"
VERDICT_EXCHANGE_ROTATION = "EXCHANGE_ROTATION"
VERDICT_WHALE_DORMANT = "WHALE_DORMANT"
VERDICT_NEUTRAL = "NEUTRAL"

ENTITY_WHALE = "likely_individual_whale"
ENTITY_DISTRIBUTOR = "likely_distributor"
ENTITY_ROUTER = "likely_exchange_rotator"
ENTITY_DORMANT_WHALE = "likely_dormant_whale"
ENTITY_UNKNOWN = "unknown"

# -----------------------------------------------------------------------------
# SCORING DIMENSIONS – adjust thresholds here
# -----------------------------------------------------------------------------

# Inflow/outflow ratio
INFLOW_OUTFLOW_RATIO_ACCUM = 1.5    # inflow/outflow >= this → accumulation signal
OUTFLOW_INFLOW_RATIO_DIST = 1.5     # outflow/inflow >= this → distribution signal
NET_INFLOW_MIN_ETH = 50.0
NET_OUTFLOW_MIN_ETH = 50.0

# Tx frequency (txs per day)
TX_FREQ_HIGH_TXS_PER_DAY = 0.5      # >= this → high activity (exchange rotation)
TX_FREQ_LOW_TXS_PER_DAY = 0.1       # <= this → low activity (dormancy)
TX_FREQ_MIN_DAYS = 1.0              # min span_days to compute frequency

# Counterparties (unique addresses)
COUNTERPARTIES_MANY = 15            # >= this → routing/exchange behavior
COUNTERPARTIES_FEW = 10             # <= this + high value → whale accumulation

# Large transfers (ETH per tx)
LARGE_TRANSFER_ETH = 10.0           # single tx >= this is "large"
SPIKE_ETH = 25.0                    # tx >= this counts as spike
LARGE_TRANSFERS_MIN_COUNT = 2       # accumulation: multiple large inflows
WHALE_HISTORICAL_ETH = 200.0        # total flow >= this → whale history

# Recency (recent window vs historical)
RECENCY_DAYS = 30
RECENCY_MAX_TXS_DORMANT = 3         # <= this in recent window → dormant
RECENCY_MIN_HISTORICAL_TXS = 10     # need this much history for dormancy
RECENCY_SPAN_DAYS_WHALE = 60        # span >= this + few recent → dormant whale

# Exchange rotation
EXCHANGE_ROTATION_MIN_TXS = 30
TIMING_MIN_TXS_FOR_PATTERN = 5


def _seconds_to_days(seconds: float) -> float:
    return seconds / (24 * 3600) if seconds else 0.0


def _compute_intelligence_metrics(transactions: list, wallet_address: str) -> dict[str, Any]:
    """
    Compute all metrics needed for classification.
    Reuses behavior.analyze_transactions; adds timing, spikes, ratios.
    """
    base = behavior.analyze_transactions(transactions, wallet_address=wallet_address)
    wallet_lower = (wallet_address or "").lower()

    total_in = base["total_in_eth"]
    total_out = base["total_out_eth"]
    net_eth = total_in - total_out
    total_txs = base["total_txs"]
    num_counterparties = base["unique_counterparties"]
    large_transfers_count = base["large_transfers_count"]
    first_ts = base.get("first_seen")
    last_ts = base.get("last_seen")

    # Time span, tx frequency, and recency
    span_seconds = (last_ts - first_ts) if (first_ts and last_ts) else 0
    span_days = _seconds_to_days(span_seconds)
    tx_frequency = (total_txs / span_days) if span_days >= TX_FREQ_MIN_DAYS else 0.0
    now_ts = last_ts if last_ts else 0
    recent_cutoff_ts = now_ts - (RECENCY_DAYS * 24 * 3600) if now_ts else 0

    # In/out ratios (avoid div by zero)
    inflow_outflow_ratio = (total_in / total_out) if total_out > 0 else (total_in * 10.0 if total_in else 0)
    outflow_inflow_ratio = (total_out / total_in) if total_in > 0 else (total_out * 10.0 if total_out else 0)

    # Recent activity count (for dormancy)
    recent_tx_count = 0
    # Large transfer spikes (txs >= SPIKE_ETH)
    spike_count = 0
    spike_total_eth = 0.0
    # Per-direction value lists for "staggered" detection (multiple smaller exits)
    in_values: list[float] = []
    out_values: list[float] = []
    # Timestamps for timing pattern
    tx_timestamps: list[int] = []

    for tx in transactions:
        from_addr = (tx.get("from") or "").lower()
        to_addr = (tx.get("to") or "").lower()
        value_eth = behavior.wei_to_eth(tx.get("value") or "0")
        ts = tx.get("timeStamp")
        try:
            ts_int = int(ts) if ts is not None else None
        except (TypeError, ValueError):
            ts_int = None

        if ts_int is not None:
            tx_timestamps.append(ts_int)
            if ts_int >= recent_cutoff_ts:
                recent_tx_count += 1

        if value_eth >= SPIKE_ETH:
            spike_count += 1
            spike_total_eth += value_eth

        if wallet_lower:
            if from_addr == wallet_lower:
                out_values.append(value_eth)
            if to_addr == wallet_lower:
                in_values.append(value_eth)

    # Staggered distribution: many smaller outflows (median outflow < large transfer)
    out_values_sorted = sorted(out_values) if out_values else []
    median_out = out_values_sorted[len(out_values_sorted) // 2] if out_values_sorted else 0.0
    staggered_exits = (
        len(out_values) >= 5 and median_out < LARGE_TRANSFER_ETH and total_out > NET_OUTFLOW_MIN_ETH
    )

    # Repeated timing: same hour of day (UTC) appearing multiple times
    hour_counts: dict[int, int] = defaultdict(int)
    for ts in tx_timestamps:
        hour_counts[(ts // 3600) % 24] += 1
    max_same_hour = max(hour_counts.values()) if hour_counts else 0
    repeated_timing = max_same_hour >= TIMING_MIN_TXS_FOR_PATTERN

    # Total historical flow (in + out) for whale/dormant
    total_flow_eth = total_in + total_out
    historically_large = total_flow_eth >= WHALE_HISTORICAL_ETH
    dormant_candidate = (
        total_txs >= RECENCY_MIN_HISTORICAL_TXS
        and recent_tx_count <= RECENCY_MAX_TXS_DORMANT
        and historically_large
    )

    return {
        # Inflow/outflow ratio
        "total_in_eth": total_in,
        "total_out_eth": total_out,
        "net_eth": net_eth,
        "inflow_outflow_ratio": round(inflow_outflow_ratio, 4) if total_out > 0 else None,
        "outflow_inflow_ratio": round(outflow_inflow_ratio, 4) if total_in > 0 else None,
        # Tx frequency (txs per day)
        "total_txs": total_txs,
        "span_days": round(span_days, 2),
        "tx_frequency": round(tx_frequency, 4) if tx_frequency else 0.0,
        # Counterparties
        "unique_counterparties": num_counterparties,
        # Large transfers
        "large_transfers_count": large_transfers_count,
        "spike_count": spike_count,
        "spike_total_eth": round(spike_total_eth, 4),
        # Recency
        "recent_tx_count": recent_tx_count,
        "first_seen": first_ts,
        "last_seen": last_ts,
        # Derived
        "staggered_exits": staggered_exits,
        "repeated_timing": repeated_timing,
        "total_flow_eth": round(total_flow_eth, 4),
        "historically_large": historically_large,
        "dormant_candidate": dormant_candidate,
        "num_inflows": len(in_values),
        "num_outflows": len(out_values),
    }


# -----------------------------------------------------------------------------
# SCORING RULES – (weight, predicate) per verdict. Tune weights to adjust sensitivity.
# Rules use: inflow/outflow ratio | tx frequency | counterparties | large transfers | recency
# -----------------------------------------------------------------------------

def _score_signals(metrics: dict[str, Any], signals: list[tuple[float, Callable[[dict], bool]]]) -> float:
    """Sum weights for all signals whose predicate is True."""
    return sum(w for w, pred in signals if pred(metrics))


# SMART_MONEY_ACCUMULATION: inflow dominance, repeated buys, few counterparties, large inflows
SIGNALS_ACCUMULATION: list[tuple[float, Callable[[dict], bool]]] = [
    (0.30, lambda m: (m.get("inflow_outflow_ratio") or 0) >= INFLOW_OUTFLOW_RATIO_ACCUM),
    (0.25, lambda m: m["net_eth"] >= NET_INFLOW_MIN_ETH),
    (0.20, lambda m: m["num_inflows"] >= 3 and m["total_in_eth"] >= NET_INFLOW_MIN_ETH),
    (0.15, lambda m: m["unique_counterparties"] <= COUNTERPARTIES_FEW and m["total_in_eth"] >= LARGE_TRANSFER_ETH),
    (0.10, lambda m: m["large_transfers_count"] >= LARGE_TRANSFERS_MIN_COUNT),
]
MAX_SCORE_ACCUMULATION = sum(w for w, _ in SIGNALS_ACCUMULATION)

# STEALTH_DISTRIBUTION: outflow dominance, staggered exits, distribution pattern
SIGNALS_DISTRIBUTION: list[tuple[float, Callable[[dict], bool]]] = [
    (0.30, lambda m: (m.get("outflow_inflow_ratio") or 0) >= OUTFLOW_INFLOW_RATIO_DIST),
    (0.25, lambda m: m["net_eth"] <= -NET_OUTFLOW_MIN_ETH),
    (0.20, lambda m: m["staggered_exits"]),
    (0.15, lambda m: m["num_outflows"] >= 5),
    (0.10, lambda m: m["spike_count"] >= 1 and m["total_out_eth"] > m["total_in_eth"]),
]
MAX_SCORE_DISTRIBUTION = sum(w for w, _ in SIGNALS_DISTRIBUTION)

# EXCHANGE_ROTATION: many counterparties, high tx frequency, routing behavior
SIGNALS_EXCHANGE_ROTATION: list[tuple[float, Callable[[dict], bool]]] = [
    (0.35, lambda m: m["unique_counterparties"] >= COUNTERPARTIES_MANY),
    (0.30, lambda m: m["tx_frequency"] >= TX_FREQ_HIGH_TXS_PER_DAY or m["total_txs"] >= EXCHANGE_ROTATION_MIN_TXS),
    (0.20, lambda m: m["total_flow_eth"] >= WHALE_HISTORICAL_ETH),
    (0.15, lambda m: m["repeated_timing"]),
]
MAX_SCORE_EXCHANGE_ROTATION = sum(w for w, _ in SIGNALS_EXCHANGE_ROTATION)

# WHALE_DORMANT: low recency (few recent txs), historically large flow
SIGNALS_WHALE_DORMANT: list[tuple[float, Callable[[dict], bool]]] = [
    (0.45, lambda m: m["dormant_candidate"]),
    (0.30, lambda m: m["recent_tx_count"] <= RECENCY_MAX_TXS_DORMANT and m["historically_large"]),
    (0.25, lambda m: m["span_days"] >= RECENCY_SPAN_DAYS_WHALE and m["recent_tx_count"] <= 2),
]
MAX_SCORE_WHALE_DORMANT = sum(w for w, _ in SIGNALS_WHALE_DORMANT)


def _compute_all_scores(metrics: dict[str, Any]) -> dict[str, float]:
    """Return normalized 0–1 score for each verdict."""
    raw = {
        VERDICT_SMART_MONEY_ACCUMULATION: _score_signals(metrics, SIGNALS_ACCUMULATION) / MAX_SCORE_ACCUMULATION,
        VERDICT_STEALTH_DISTRIBUTION: _score_signals(metrics, SIGNALS_DISTRIBUTION) / MAX_SCORE_DISTRIBUTION,
        VERDICT_EXCHANGE_ROTATION: _score_signals(metrics, SIGNALS_EXCHANGE_ROTATION) / MAX_SCORE_EXCHANGE_ROTATION,
        VERDICT_WHALE_DORMANT: _score_signals(metrics, SIGNALS_WHALE_DORMANT) / MAX_SCORE_WHALE_DORMANT,
    }
    return {k: min(1.0, round(v, 4)) for k, v in raw.items()}


# Confidence: blend of signal strength, margin over second-best, and data quality
CONFIDENCE_MIN = 0.30
CONFIDENCE_MAX = 0.95
CONFIDENCE_STRENGTH_WEIGHT = 0.50   # how much raw score matters
CONFIDENCE_MARGIN_WEIGHT = 0.35    # how much gap to second-best matters
CONFIDENCE_DATA_WEIGHT = 0.15      # how much tx count (data quality) matters
DATA_QUALITY_TXS_FLOOR = 10        # txs below this reduce data-quality component
DATA_QUALITY_TXS_CEILING = 80      # txs above this = full data quality


def _compute_confidence(
    best_verdict: str,
    scores: dict[str, float],
    metrics: dict[str, Any],
    neutral_fallback: bool,
) -> float:
    """
    Confidence in [CONFIDENCE_MIN, CONFIDENCE_MAX] from:
    - strength: winning verdict's normalized score
    - margin: gap between best and second-best (reduces when tie or close)
    - data_quality: more txs = more reliable (capped)
    """
    if neutral_fallback:
        return round(CONFIDENCE_MIN + 0.15, 2)  # fixed low confidence for NEUTRAL

    strength = scores[best_verdict]
    ordered = sorted(scores.items(), key=lambda x: -x[1])
    second_score = ordered[1][1] if len(ordered) > 1 else 0.0
    margin = min(1.0, max(0.0, strength - second_score))

    txs = metrics.get("total_txs", 0)
    if txs <= DATA_QUALITY_TXS_FLOOR:
        data_quality = txs / DATA_QUALITY_TXS_FLOOR
    else:
        data_quality = min(1.0, (txs - DATA_QUALITY_TXS_FLOOR) / (DATA_QUALITY_TXS_CEILING - DATA_QUALITY_TXS_FLOOR))

    confidence = (
        CONFIDENCE_MIN
        + (CONFIDENCE_MAX - CONFIDENCE_MIN)
        * (
            CONFIDENCE_STRENGTH_WEIGHT * strength
            + CONFIDENCE_MARGIN_WEIGHT * margin
            + CONFIDENCE_DATA_WEIGHT * data_quality
        )
    )
    return round(min(CONFIDENCE_MAX, max(CONFIDENCE_MIN, confidence)), 2)


def _pick_verdict_and_confidence(metrics: dict[str, Any]) -> tuple[str, str, float, str]:
    """
    Score each verdict; return best verdict, entity_inference, confidence (0–1), behavior_summary.
    """
    scores = _compute_all_scores(metrics)
    best_verdict = max(scores, key=scores.get)
    best_score = scores[best_verdict]

    # Require minimum signal for non-NEUTRAL
    neutral_fallback = best_score < 0.30
    if neutral_fallback:
        best_verdict = VERDICT_NEUTRAL

    entity_map = {
        VERDICT_SMART_MONEY_ACCUMULATION: ENTITY_WHALE,
        VERDICT_STEALTH_DISTRIBUTION: ENTITY_DISTRIBUTOR,
        VERDICT_EXCHANGE_ROTATION: ENTITY_ROUTER,
        VERDICT_WHALE_DORMANT: ENTITY_DORMANT_WHALE,
        VERDICT_NEUTRAL: ENTITY_UNKNOWN,
    }
    entity_inference = entity_map[best_verdict]

    confidence = _compute_confidence(best_verdict, scores, metrics, neutral_fallback)
    summary = _behavior_summary(best_verdict, metrics, best_score)
    return best_verdict, entity_inference, confidence, summary


def _behavior_summary(verdict: str, metrics: dict[str, Any], score: float) -> str:
    """One-line human-readable behavior summary."""
    if verdict == VERDICT_SMART_MONEY_ACCUMULATION:
        return (
            f"Net inflow dominance (net {metrics['net_eth']:.1f} ETH) with "
            f"repeated high-value buys; {metrics['unique_counterparties']} counterparties."
        )
    if verdict == VERDICT_STEALTH_DISTRIBUTION:
        return (
            f"Sustained outflows (net {metrics['net_eth']:.1f} ETH) with "
            f"staggered transfers; distribution pattern."
        )
    if verdict == VERDICT_EXCHANGE_ROTATION:
        return (
            f"High counterparty count ({metrics['unique_counterparties']}), "
            f"{metrics['total_txs']} txs; exchange or routing behavior."
        )
    if verdict == VERDICT_WHALE_DORMANT:
        return (
            f"Historically large flow ({metrics['total_flow_eth']:.0f} ETH) with "
            f"low recent activity ({metrics['recent_tx_count']} txs in last {RECENCY_DAYS}d)."
        )
    return "No strong directional behavior detected; insufficient signal for classification."


def classify_wallet(
    transactions: list,
    wallet_address: str,
    *,
    include_metrics: bool = True,
) -> dict[str, Any]:
    """
    Classify wallet behavior into a high-value intelligence verdict.

    Args:
        transactions: List of Etherscan-style tx dicts (from, to, value, timeStamp).
        wallet_address: The wallet address to classify.
        include_metrics: If True, include metrics_used in output.

    Returns:
        JSON-ready dict:
          - address
          - verdict (SMART_MONEY_ACCUMULATION | STEALTH_DISTRIBUTION | EXCHANGE_ROTATION | WHALE_DORMANT | NEUTRAL)
          - confidence (0–1)
          - entity_inference / entity_type (likely_individual_whale | likely_distributor | etc.)
          - behavior_summary (human-readable)
          - metrics_used (if include_metrics)
    """
    if not transactions:
        return {
            "address": wallet_address,
            "verdict": VERDICT_NEUTRAL,
            "confidence": 0.30,
            "entity_inference": ENTITY_UNKNOWN,
            "entity_type": ENTITY_UNKNOWN,
            "behavior_summary": "No transaction data available.",
            "metrics_used": {} if include_metrics else None,
        }

    metrics = _compute_intelligence_metrics(transactions, wallet_address)
    verdict, entity_inference, confidence, behavior_summary = _pick_verdict_and_confidence(metrics)

    out = {
        "address": wallet_address,
        "verdict": verdict,
        "confidence": confidence,
        "entity_inference": entity_inference,
        "entity_type": entity_inference,  # alias for API consumers
        "behavior_summary": behavior_summary,
    }
    if include_metrics:
        out["metrics_used"] = {
            k: (round(v, 4) if isinstance(v, float) else v)
            for k, v in metrics.items()
        }
    return out
