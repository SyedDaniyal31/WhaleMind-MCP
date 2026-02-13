/**
 * Smart money signature: early entry into trending tokens, consistent profitable exits,
 * interaction with alpha wallets. Heuristic: moderate volume, diverse but not CEX-like,
 * DEX usage, non-bot timing, net positive flow.
 */

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

export function computeSmartMoneySignature(features, classification) {
  const signals = [];
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const dexRatio = n(beh.dex_interaction_ratio);
  const sameBlockMax = n(beh.same_block_max_txs);
  const burstScore = n(beh.burst_activity_score);
  const uniqueCp = n(net.unique_counterparties);
  const netFlow = n(vol.net_flow);
  const lifetimeVolume = n(vol.lifetime_volume_eth);
  const walletAgeDays = n(act.wallet_age_days);
  const avgTxPerDay = n(act.avg_tx_per_day);
  const entityType = classification?.entity_type || "";

  let score = 0;
  if (lifetimeVolume >= 50 && lifetimeVolume <= 5000 && uniqueCp >= 10 && uniqueCp <= 200) {
    score += 0.2;
    signals.push("moderate_volume_diverse_cp");
  }
  if (dexRatio >= 0.2 && dexRatio <= 0.7 && sameBlockMax < 5) {
    score += 0.2;
    signals.push("dex_usage_not_bot");
  }
  if (netFlow > 0 && lifetimeVolume > 20) {
    score += 0.15;
    signals.push("net_positive_flow");
  }
  if (burstScore < 0.5 && avgTxPerDay >= 0.1 && avgTxPerDay <= 10) {
    score += 0.15;
    signals.push("strategic_timing");
  }
  if (walletAgeDays >= 30 && entityType !== "CEX Hot Wallet" && entityType !== "MEV Bot") {
    score += 0.15;
    signals.push("non_cex_mev_profile");
  }
  if (entityType === "Individual Whale" || entityType === "Fund / Institutional Whale") {
    score += 0.1;
    signals.push("whale_or_fund_base");
  }
  if (uniqueCp >= 5 && uniqueCp <= 150 && dexRatio > 0.1) {
    score += 0.05;
    signals.push("alpha_like_diversity");
  }

  const smart_money_score = Math.min(1, Math.round(score * 100) / 100);
  return { smart_money_score, signals };
}
