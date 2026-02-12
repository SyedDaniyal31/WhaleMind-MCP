/**
 * Phase 6 — Risk scoring (hardened).
 * behavioral_risk = base_risk × confidence_score. Counterparty not HIGH if wallet age < 30 days.
 */

/**
 * Compute risk_profile. Behavioral risk scaled by confidence; counterparty capped for new wallets.
 */
export function computeRiskProfile(features, classification, context = {}) {
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const act = features?.activity_metrics || {};
  const entityType = classification?.entity_type || "Unknown";
  const confidenceScore = Math.max(0.05, Math.min(1, context.confidence_score ?? 0.5));

  const maxTx = vol.max_single_tx || 0;
  const lifetimeEth = vol.lifetime_volume_eth || 0;
  const uniqueCp = net.unique_counterparties || 0;
  const repeatRatio = net.repeat_counterparty_ratio || 0;
  const top5Share = net.top_5_counterparty_share || 0;
  const walletAgeDays = act.wallet_age_days ?? 0;

  let marketScore = 0.5;
  if (maxTx >= 500) marketScore = 0.9;
  else if (maxTx >= 100) marketScore = 0.75;
  else if (maxTx >= 50) marketScore = 0.6;
  else if (maxTx < 10 && lifetimeEth < 100) marketScore = 0.2;
  const market_impact_risk = {
    score: Math.round(marketScore * 100) / 100,
    label: scoreToLabel(marketScore),
  };

  let cpScore = 0.5;
  if (uniqueCp < 5) cpScore = 0.7;
  else if (uniqueCp >= 50) cpScore = 0.3;
  if (top5Share > 0.8) cpScore = Math.min(1, cpScore + 0.2);
  if (repeatRatio > 0.5) cpScore = Math.min(1, cpScore + 0.1);
  if (walletAgeDays < 30) {
    cpScore = Math.min(cpScore, 0.6);
  }
  const counterparty_risk = {
    score: Math.round(cpScore * 100) / 100,
    label: scoreToLabel(cpScore),
  };

  let baseBeh = 0.5;
  if (entityType === "MEV Bot") baseBeh = 0.75;
  else if (entityType === "CEX Hot Wallet") baseBeh = 0.4;
  else if (entityType === "Fund / Institutional Whale") baseBeh = 0.35;
  else if (beh.same_block_3_plus_count >= 2) baseBeh = 0.65;
  else if (beh.dex_interaction_ratio > 0.5) baseBeh = 0.55;
  const behavioral_risk = {
    score: Math.round(Math.min(1, baseBeh * confidenceScore) * 100) / 100,
    label: scoreToLabel(baseBeh * confidenceScore),
  };

  return {
    market_impact_risk,
    counterparty_risk,
    behavioral_risk,
  };
}

function scoreToLabel(score) {
  if (score >= 0.65) return "HIGH";
  if (score >= 0.35) return "MEDIUM";
  return "LOW";
}
