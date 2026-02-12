/**
 * Tier-S++ Layer 2 — Behavioral metrics (derived signals).
 * Input: Layer 1 feature summary + context (cluster_size, funding_source_count).
 * Output: cex_hub_score, mev_score, fund_score, whale_score (0–1).
 */

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, typeof x === "number" ? x : 0));
}

/**
 * Compute Layer 2 behavioral scores from Layer 1 features and context.
 * @param {Object} features - from extractFeatures()
 * @param {Object} context - { cluster_size, funding_source_count }
 * @returns {{ cex_hub_score: number, mev_score: number, fund_score: number, whale_score: number, signal_counts?: Object }}
 */
export function computeBehavioralScores(features, context = {}) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  const clusterSize = n(context.cluster_size, 0);
  const fundingSourceCount = n(context.funding_source_count, 0);

  const uniqueCp = n(net.unique_counterparties, 0);
  const totalTxs = (n(act.wallet_age_days, 1) * n(act.avg_tx_per_day, 0)) || 0;
  const inflowOutflowRatio = n(vol.inflow_outflow_ratio, 0);
  const repeatRatio = n(net.repeat_interaction_ratio, net.repeat_counterparty_ratio) ?? n(net.repeat_counterparty_ratio, 0);
  const sweepPattern = n(beh.sweep_pattern_score, 0);
  const zeroBalanceFreq = n(beh.zero_balance_frequency, 0);
  const burstScore = n(tem.burst_activity_score, 0);
  const sameBlockMax = n(beh.same_block_max_txs, 0);
  const dexRatio = n(beh.dex_interaction_ratio, 0);
  const gasSpikeRatio = n(beh.gas_spike_ratio, 0);
  const walletAgeDays = n(act.wallet_age_days, 0);
  const avgTxPerDay = n(act.avg_tx_per_day, 0);
  const avgTxSize = n(vol.avg_tx_size, 0);
  const maxSingleTx = n(vol.max_single_tx, 0);
  const top5Share = n(net.top_5_counterparty_share, 0);
  const lifetimeVolume = n(vol.lifetime_volume_eth, 0);
  const cexVolumeShare = n(beh.cex_volume_share, 0);

  // ─── CEX hub components (high cp, symmetric flows, zeroing, deposit bursts, large cluster) ───
  const cpScore = uniqueCp >= 500 ? 1 : uniqueCp >= 200 ? 0.7 : uniqueCp >= 100 ? 0.4 : uniqueCp >= 50 ? 0.2 : 0;
  const flowSymmetry = inflowOutflowRatio >= 0.9 ? 1 : inflowOutflowRatio >= 0.7 ? 0.7 : inflowOutflowRatio >= 0.5 ? 0.4 : 0;
  const zeroingScore = zeroBalanceFreq >= 0.1 ? Math.min(1, zeroBalanceFreq * 5) : 0;
  const depositBurstScore = burstScore >= 0.3 ? Math.min(1, burstScore * 1.5) : 0;
  const clusterScore = clusterSize >= 20 ? 1 : clusterSize >= 10 ? 0.6 : clusterSize >= 3 ? 0.3 : 0;
  const cex_hub_score = clamp01(
    0.25 * cpScore +
      0.25 * flowSymmetry +
      0.2 * sweepPattern +
      0.2 * clusterScore +
      0.1 * zeroingScore
  );

  // ─── MEV components (same-block bundles, DEX dominance, gas premium, short holding, low repeat cp) ───
  const sameBlockScore = sameBlockMax >= 5 ? 1 : sameBlockMax >= 3 ? 0.6 : sameBlockMax >= 1 ? 0.2 : 0;
  const dexScore = dexRatio >= 0.6 ? 1 : dexRatio >= 0.4 ? 0.6 : dexRatio >= 0.2 ? 0.3 : 0;
  const gasScore = gasSpikeRatio >= 0.2 ? 1 : gasSpikeRatio >= 0.1 ? 0.5 : 0;
  const burstMev = burstScore >= 0.5 ? 1 : burstScore >= 0.3 ? 0.5 : 0;
  const lowRepeatCp = uniqueCp < 300 ? 1 : uniqueCp < 500 ? 0.5 : 0;
  const mev_score = clamp01(
    0.3 * sameBlockScore +
      0.3 * dexScore +
      0.2 * gasScore +
      0.15 * burstMev +
      0.05 * (1 - Math.min(1, repeatRatio * 2))
  );

  // ─── Fund / institutional (large infrequent txs, low DEX, long holding, custody-like) ───
  const largeTxScore = maxSingleTx >= 500 ? 1 : maxSingleTx >= 100 ? 0.7 : maxSingleTx >= 50 ? 0.4 : 0;
  const lowFreqScore = avgTxPerDay < 1 && walletAgeDays >= 180 ? 1 : avgTxPerDay < 2 && walletAgeDays >= 90 ? 0.6 : 0;
  const lowDexScore = dexRatio < 0.2 ? 1 : dexRatio < 0.4 ? 0.5 : 0;
  const custodyScore = cexVolumeShare >= 0.2 ? 0.8 : cexVolumeShare >= 0.1 ? 0.4 : 0;
  const fund_score = clamp01(
    0.3 * largeTxScore +
      0.25 * lowFreqScore +
      0.25 * lowDexScore +
      0.2 * custodyScore
  );

  // ─── Individual whale (high volume, moderate frequency, consistent, non-hub) ───
  const volumeScore = lifetimeVolume >= 1000 ? 1 : lifetimeVolume >= 500 ? 0.7 : lifetimeVolume >= 100 ? 0.4 : 0;
  const moderateFreq = avgTxPerDay >= 0.5 && avgTxPerDay <= 20 ? 1 : avgTxPerDay > 0 ? 0.5 : 0;
  const nonHub = top5Share > 0.3 || uniqueCp < 200 ? 0.8 : 1;
  const whale_score = clamp01(
    0.35 * volumeScore +
      0.35 * moderateFreq +
      0.2 * (1 - cex_hub_score) +
      0.1 * nonHub
  );

  return {
    cex_hub_score: Math.round(cex_hub_score * 100) / 100,
    mev_score: Math.round(mev_score * 100) / 100,
    fund_score: Math.round(fund_score * 100) / 100,
    whale_score: Math.round(whale_score * 100) / 100,
    _components: {
      cex: { cpScore, flowSymmetry, sweepPattern, clusterScore, zeroingScore },
      mev: { sameBlockScore, dexScore, gasScore, burstMev, lowRepeatCp },
      fund: { largeTxScore, lowFreqScore, lowDexScore, custodyScore },
      whale: { volumeScore, moderateFreq, nonHub },
    },
  };
}
