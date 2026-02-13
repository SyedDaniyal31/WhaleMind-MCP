/**
 * Exchange signature: thousands of inbound small deposits, batched withdrawals,
 * hot/cold patterns, high unique counterparties.
 */

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

export function computeExchangeSignature(features, txs, address) {
  const signals = [];
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const totalTxs = (txs || []).length;
  const uniqueCp = n(net.unique_counterparties);
  const totalIn = n(vol.total_in_eth);
  const totalOut = n(vol.total_out_eth);
  const inflowOutflowRatio = totalIn + totalOut > 0 ? Math.min(totalIn, totalOut) / Math.max(totalIn, totalOut, 0.001) : 0;
  const top5Share = n(net.top_5_counterparty_share);
  const zeroBalanceFreq = n(beh.zero_balance_frequency);
  const sweepScore = n(beh.sweep_pattern_score);
  const sameBlock3Plus = n(beh.same_block_3_plus_count);
  const walletAgeDays = n(act.wallet_age_days);
  const avgTxPerDay = n(act.avg_tx_per_day);

  let score = 0;
  if (uniqueCp >= 500) {
    score += 0.3;
    signals.push("high_unique_counterparties");
  } else if (uniqueCp >= 200) {
    score += 0.15;
    signals.push("many_counterparties");
  }
  if (totalTxs >= 1000) {
    score += 0.25;
    signals.push("high_tx_count");
  } else if (totalTxs >= 300) {
    score += 0.1;
    signals.push("moderate_tx_count");
  }
  if (inflowOutflowRatio >= 0.85) {
    score += 0.2;
    signals.push("symmetric_inflow_outflow");
  } else if (inflowOutflowRatio >= 0.6) {
    score += 0.1;
  }
  if (top5Share < 0.4 && uniqueCp > 50) {
    score += 0.1;
    signals.push("hub_spoke_flow");
  }
  if (zeroBalanceFreq > 0.05) {
    score += 0.1;
    signals.push("frequent_zero_balance");
  }
  if (sweepScore > 0.2) {
    score += 0.1;
    signals.push("sweep_pattern");
  }
  if (sameBlock3Plus >= 2) {
    score += 0.05;
    signals.push("batched_withdrawals");
  }
  if (walletAgeDays >= 180 && avgTxPerDay > 5) {
    score += 0.05;
    signals.push("sustained_hot_activity");
  }

  const exchange_confidence_score = Math.min(1, Math.round(score * 100) / 100);
  return { exchange_confidence_score, signals };
}
