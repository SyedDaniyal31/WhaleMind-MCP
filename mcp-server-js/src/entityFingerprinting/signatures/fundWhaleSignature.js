/**
 * Fund/whale signature: low frequency, high value txs, limited counterparties, strategic timing.
 */

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

export function computeFundWhaleSignature(features) {
  const signals = [];
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const walletAgeDays = n(act.wallet_age_days);
  const avgTxPerDay = n(act.avg_tx_per_day);
  const maxSingleTx = n(vol.max_single_tx);
  const avgTxSize = n(vol.avg_tx_size);
  const uniqueCp = n(net.unique_counterparties);
  const top5Share = n(net.top_5_counterparty_share);
  const dexRatio = n(beh.dex_interaction_ratio);
  const lifetimeVolume = n(vol.lifetime_volume_eth);
  const cexVolumeShare = n(beh.cex_volume_share);

  let score = 0;
  if (maxSingleTx >= 100) {
    score += 0.25;
    signals.push("large_tx_size");
  } else if (maxSingleTx >= 50) {
    score += 0.12;
    signals.push("high_value_txs");
  }
  if (avgTxPerDay < 1 && walletAgeDays >= 90) {
    score += 0.25;
    signals.push("low_frequency");
  } else if (avgTxPerDay < 2 && walletAgeDays >= 30) {
    score += 0.1;
  }
  if (uniqueCp <= 50 && lifetimeVolume > 100) {
    score += 0.2;
    signals.push("limited_counterparties");
  } else if (uniqueCp <= 100) {
    score += 0.08;
  }
  if (walletAgeDays >= 180) {
    score += 0.1;
    signals.push("long_holding_period");
  }
  if (dexRatio < 0.3 && lifetimeVolume > 50) {
    score += 0.1;
    signals.push("low_dex_usage");
  }
  if (cexVolumeShare >= 0.1 && cexVolumeShare <= 0.8) {
    score += 0.05;
    signals.push("custody_like");
  }
  if (top5Share > 0.5) {
    score += 0.05;
    signals.push("concentrated_flow");
  }

  const fund_score = Math.min(1, Math.round(score * 100) / 100);
  return { fund_score, signals };
}
