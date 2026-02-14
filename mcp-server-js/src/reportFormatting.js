/**
 * Institutional-grade report formatting.
 * Analyst language, structured sections, confidence bands, interpretation.
 * No apologetic or uncertain tone; frame uncertainty as analytical prudence.
 */

const SAMPLING_QUALITY_HIGH_MIN = 1001;
const SAMPLING_QUALITY_MEDIUM_MIN = 300;
const CONFIDENCE_HIGH_MIN = 0.75;
const CONFIDENCE_MEDIUM_MIN = 0.5;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

/**
 * Sampling Quality: HIGH => >1000 analyzed, MEDIUM => 300-1000, LOW => <300.
 */
export function getSamplingQuality(analyzedTx) {
  const a = n(analyzedTx);
  if (a >= SAMPLING_QUALITY_HIGH_MIN) return "HIGH";
  if (a >= SAMPLING_QUALITY_MEDIUM_MIN) return "MEDIUM";
  return "LOW";
}

/**
 * Entity Confidence band from score: HIGH (≥0.75), MEDIUM (0.5-0.75), LOW (<0.5).
 */
export function getEntityConfidenceBand(confidenceScore) {
  const s = n(confidenceScore);
  if (s >= CONFIDENCE_HIGH_MIN) return "HIGH";
  if (s >= CONFIDENCE_MEDIUM_MIN) return "MEDIUM";
  return "LOW";
}

/**
 * Build reason bullets from features and raw confidence reasons.
 * Categories: Wallet age, Behavioral consistency, Historical persistence, Volume stability, Counterparty diversity.
 */
export function buildConfidenceReasonBullets(features, confidenceReasons) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const reasons = Array.isArray(confidenceReasons) ? confidenceReasons : [];
  const bullets = [];

  const walletAgeDays = n(act.wallet_age_days);
  if (walletAgeDays >= 180) bullets.push("Wallet age: Long history (≥180 days) supports classification stability.");
  else if (walletAgeDays >= 90) bullets.push("Wallet age: Moderate history (90–180 days).");
  else if (walletAgeDays >= 30) bullets.push("Wallet age: Short window (30–90 days); limited persistence.");
  else if (walletAgeDays > 0) bullets.push("Wallet age: Insufficient history (<30 days) for high confidence.");

  const stdDev = n(act.tx_frequency_std_dev);
  const avgPerDay = n(act.avg_tx_per_day);
  if (avgPerDay > 0 && stdDev / avgPerDay < 0.5) bullets.push("Behavioral consistency: Stable transaction frequency in observed window.");
  else if (reasons.some((r) => /contradiction|partial history|sample/i.test(r))) bullets.push("Behavioral consistency: Contradiction filters or partial history applied; consistency not fully established.");

  const totalTxs = n(vol.lifetime_volume_eth) ? (features?.activity_metrics?.wallet_age_days ?? 0) * (act.avg_tx_per_day ?? 0) : 0;
  const txs = Math.round(totalTxs) || (act.wallet_age_days ?? 0) * (act.avg_tx_per_day ?? 0);
  if (txs >= 1000) bullets.push("Historical persistence: High transaction count supports pattern reliability.");
  else if (txs >= 300) bullets.push("Historical persistence: Moderate transaction count.");
  else bullets.push("Historical persistence: Limited transaction history; definitive classification requires more data.");

  const inflowOutflow = n(vol.inflow_outflow_ratio);
  if (inflowOutflow >= 0.8) bullets.push("Volume stability: Balanced inflow/outflow indicates sustained activity pattern.");
  else if (vol.lifetime_volume_eth >= 100) bullets.push("Volume stability: Substantial volume observed.");
  else bullets.push("Volume stability: Limited volume in sample.");

  const cp = n(net.unique_counterparties);
  if (cp >= 100) bullets.push("Counterparty diversity: High diversity; classification less sensitive to single counterparties.");
  else if (cp >= 30) bullets.push("Counterparty diversity: Moderate diversity.");
  else bullets.push("Counterparty diversity: Low diversity; classification may be driven by few actors.");

  return bullets;
}

/**
 * Provisional explanation when confidence is low.
 */
export function buildProvisionalExplanation(entityType, patternType) {
  const pattern = patternType || entityType || "mixed";
  return `The wallet exhibits ${pattern} patterns but lacks sufficient historical persistence for definitive classification. Additional on-chain history or higher data coverage would strengthen the assessment.`;
}

/**
 * Human-readable interpretation: likely behavior and what is needed for certainty.
 */
export function buildInterpretation(entityType, confidenceBand, analysisMode, dataCoveragePct, samplingQuality) {
  const parts = [];
  const entity = entityType && entityType !== "Unknown" ? entityType : "Unknown (Provisional)";
  parts.push(`Classification: ${entity}.`);
  if (confidenceBand === "HIGH") {
    parts.push("On-chain patterns are consistent with this entity type; confidence is supported by data depth and behavioral consistency.");
  } else if (confidenceBand === "MEDIUM") {
    parts.push("Observed patterns align with this entity type; confidence would improve with longer history or full transaction coverage.");
  } else {
    parts.push("Patterns are suggestive but not conclusive. Definitive classification requires additional transaction history, broader coverage, or higher counterparty diversity.");
  }
  if (analysisMode === "sampled" || (typeof dataCoveragePct === "number" && dataCoveragePct < 100)) {
    parts.push("Analysis is based on a sample of available transactions; full history would allow a more complete assessment.");
  }
  if (samplingQuality === "LOW") {
    parts.push("Sample size is below the recommended threshold for high-confidence classification; additional data is advised before drawing firm conclusions.");
  }
  return parts.join(" ");
}

/**
 * Build full institutional report section.
 */
export function buildInstitutionalReport(options) {
  const {
    totalAvailableTxs,
    fetchedTxs,
    coveragePct,
    analysisMode,
    entityType,
    confidenceScore,
    confidenceReasons,
    features,
    classification,
  } = options;

  const totalTx = totalAvailableTxs != null ? totalAvailableTxs : null;
  const transactionCountLine =
    totalTx != null
      ? `${totalTx.toLocaleString()} total | ${fetchedTxs.toLocaleString()} analyzed`
      : `${fetchedTxs.toLocaleString()} analyzed (total unknown)`;
  const dataCoverageLine =
    totalAvailableTxs != null && totalAvailableTxs > 0
      ? `${coveragePct}% of total transactions`
      : analysisMode === "full"
        ? "100% of total transactions"
        : "Sample only; total population unknown";
  const samplingQuality = getSamplingQuality(fetchedTxs);
  const entityConfidenceBand = getEntityConfidenceBand(confidenceScore);
  const confidenceReasonBullets = buildConfidenceReasonBullets(features, confidenceReasons);

  const isLowConfidence = confidenceScore < LOW_CONFIDENCE_THRESHOLD;
  const displayEntityType = isLowConfidence && entityType && entityType !== "Unknown"
    ? "Unknown (Provisional)"
    : (entityType || "Unknown");
  const provisionalExplanation = isLowConfidence && entityType && entityType !== "Unknown"
    ? buildProvisionalExplanation(entityType, classification?.entity_type || entityType)
    : null;
  const interpretation = buildInterpretation(
    displayEntityType,
    entityConfidenceBand,
    analysisMode,
    coveragePct,
    samplingQuality
  );

  const optionalMetrics = features?.optional_metrics
    ? {
        behavioral_stability_score: Number(features.optional_metrics.behavioral_stability_score) || 0,
        flow_consistency_metric: Number(features.optional_metrics.flow_consistency_metric) || 0,
        counterparty_entropy_score: Number(features.optional_metrics.counterparty_entropy_score) || 0,
      }
    : null;

  return {
    transaction_count: transactionCountLine,
    data_coverage: dataCoverageLine,
    sampling_quality: samplingQuality,
    entity_confidence: `${entityConfidenceBand} (${Number(confidenceScore).toFixed(2)})`,
    entity_confidence_reasons: confidenceReasonBullets,
    entity_type_display: displayEntityType,
    provisional_explanation: provisionalExplanation,
    interpretation,
    ...(optionalMetrics && { optional_metrics: optionalMetrics }),
  };
}
