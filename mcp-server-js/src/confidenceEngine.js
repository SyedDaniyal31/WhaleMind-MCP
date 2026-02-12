/**
 * Phase 3 — Confidence engine (hardened).
 * Caps: entity_score < 0.6 → max 0.55; tx_count < 100 → cap 0.5; wallet_age < 30 days → cap 0.45.
 * "Strong signals detected" only if ≥3 strong signals and entity_score ≥ 0.7.
 */

const CAP_ENTITY_SCORE_THRESHOLD = 0.6;
const CAP_ENTITY_SCORE_MAX = 0.55;
const CAP_TX_COUNT_THRESHOLD = 100;
const CAP_TX_COUNT_MAX = 0.5;
const CAP_AGE_DAYS_THRESHOLD = 30;
const CAP_AGE_MAX = 0.45;
const STRONG_SIGNALS_MIN_COUNT = 3;
const STRONG_SIGNALS_MIN_ENTITY_SCORE = 0.7;

/**
 * Compute confidence score and reasons. Apply caps; require strong evidence for "Strong signals" message.
 */
export function computeConfidence(features, classification, context = {}) {
  const reasons = [];
  let data_quality_score = 1;
  let history_depth_factor = 1;
  let signal_strength = Math.min(1, classification?.entity_score ?? 0);

  const totalTxs = context.total_txs ?? deriveTotalTxsFromFeatures(features);
  const walletAgeDays = features?.activity_metrics?.wallet_age_days ?? 0;
  const uniqueCounterparties = features?.network_metrics?.unique_counterparties ?? 0;
  const entityScore = classification?.entity_score ?? 0;
  const signalsUsed = classification?.signals_used ?? [];

  if (totalTxs < 100) {
    data_quality_score -= 0.3;
    reasons.push("Limited history reduces certainty");
  } else if (totalTxs < 300) {
    data_quality_score -= 0.15;
    reasons.push("Moderate transaction history");
  }

  if (walletAgeDays < 30) {
    history_depth_factor -= 0.35;
    reasons.push("Wallet age under 30 days");
  } else if (walletAgeDays < 90) {
    history_depth_factor -= 0.15;
    reasons.push("Short activity window");
  }

  if (uniqueCounterparties < 10) {
    data_quality_score -= 0.2;
    reasons.push("Low counterparty count");
  } else if (uniqueCounterparties < 30) {
    data_quality_score -= 0.1;
    reasons.push("Limited counterparty diversity");
  }

  data_quality_score = Math.max(0.2, data_quality_score);
  history_depth_factor = Math.max(0.3, history_depth_factor);

  let confidence_score = data_quality_score * signal_strength * history_depth_factor;

  if (entityScore < CAP_ENTITY_SCORE_THRESHOLD) {
    confidence_score = Math.min(confidence_score, CAP_ENTITY_SCORE_MAX);
    reasons.push("Low entity score caps confidence");
  }
  if (totalTxs < CAP_TX_COUNT_THRESHOLD) {
    confidence_score = Math.min(confidence_score, CAP_TX_COUNT_MAX);
  }
  if (walletAgeDays < CAP_AGE_DAYS_THRESHOLD) {
    confidence_score = Math.min(confidence_score, CAP_AGE_MAX);
  }

  if (
    signalsUsed.length >= STRONG_SIGNALS_MIN_COUNT &&
    entityScore >= STRONG_SIGNALS_MIN_ENTITY_SCORE &&
    classification?.entity_type &&
    classification.entity_type !== "Unknown"
  ) {
    reasons.push(`Strong ${classification.entity_type} signals detected`);
  } else if (classification?.entity_type && classification.entity_type !== "Unknown") {
    reasons.push(`${classification.entity_type} classification based on on-chain patterns`);
  } else {
    reasons.push("Insufficient signals for high-confidence classification");
  }

  confidence_score = Math.round(
    Math.max(0.05, Math.min(1, confidence_score)) * 100
  ) / 100;

  return {
    confidence_score,
    confidence_reasons: [...new Set(reasons)],
  };
}

function deriveTotalTxsFromFeatures(features) {
  const act = features?.activity_metrics || {};
  const days = Math.max(0.01, act.wallet_age_days || 0);
  const perDay = act.avg_tx_per_day || 0;
  return Math.round(days * perDay) || 0;
}
