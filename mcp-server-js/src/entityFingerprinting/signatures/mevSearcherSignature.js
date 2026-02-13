/**
 * MEV searcher signature: same-block multi-tx, DEX-heavy, arbitrage-like, high burst.
 */

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

export function computeMevSearcherSignature(features) {
  const signals = [];
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  const net = features?.network_metrics || {};
  const sameBlockMax = n(beh.same_block_max_txs);
  const sameBlock3Plus = n(beh.same_block_3_plus_count);
  const dexRatio = n(beh.dex_interaction_ratio);
  const gasSpikeRatio = n(beh.gas_spike_ratio);
  const burstScore = n(tem.burst_activity_score);
  const uniqueCp = n(net.unique_counterparties);
  const repeatRatio = n(net.repeat_interaction_ratio);

  let score = 0;
  if (sameBlockMax >= 5) {
    score += 0.3;
    signals.push("same_block_multi_tx");
  } else if (sameBlockMax >= 3) {
    score += 0.15;
    signals.push("same_block_bundles");
  }
  if (dexRatio >= 0.6) {
    score += 0.25;
    signals.push("dex_heavy");
  } else if (dexRatio >= 0.4) {
    score += 0.1;
    signals.push("high_dex_ratio");
  }
  if (gasSpikeRatio > 0.2) {
    score += 0.15;
    signals.push("gas_premium_usage");
  }
  if (burstScore >= 0.5) {
    score += 0.2;
    signals.push("burst_activity");
  } else if (burstScore >= 0.2) {
    score += 0.08;
  }
  if (uniqueCp < 300 && dexRatio > 0.3) {
    score += 0.1;
    signals.push("arbitrage_like_cp");
  }
  if (repeatRatio < 0.3 && sameBlock3Plus >= 1) {
    score += 0.05;
    signals.push("short_holding_pattern");
  }

  const mev_searcher_score = Math.min(1, Math.round(score * 100) / 100);
  return { mev_searcher_score, signals };
}
