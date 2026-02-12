/**
 * Phase 2 — Entity classification engine (hardened).
 * Prefer false negatives; require multiple concurring signals; if unsure → Unknown.
 * No single heuristic assigns a strong label. Bridges do not influence Fund/CEX.
 */

const WEI_PER_ETH = 1e18;

function toEth(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const s = String(val);
  if (s.startsWith("0x")) return Number(BigInt(s)) / WEI_PER_ETH;
  return Number(s) / WEI_PER_ETH || 0;
}

const ENTITY_TYPES = ["CEX Hot Wallet", "MEV Bot", "Fund / Institutional Whale", "Individual Whale", "Unknown"];

// ─── Hardened thresholds ───────────────────────────────────────────────────
const CEX_MIN_TXS = 1001;
const CEX_MIN_COUNTERPARTIES = 201;
const CEX_MIN_AGE_DAYS = 180;
const CEX_MIN_VOLUME_SHARE = 0.3;
const CEX_MIN_CP_FOR_STRONG = 3;

const MEV_DEX_DOMINANCE = 0.5;
const MEV_SAME_BLOCK_3_PLUS_MIN = 2;
const MEV_GAS_2X_MEDIAN_MIN_TXS = 3;
const MEV_MIN_SIGNALS_REQUIRED = 3;

const FUND_LARGE_TX_ETH = 100;
const FUND_MIN_LARGE_TXS = 2;
const FUND_MIN_AGE_DAYS = 180;
const INDIVIDUAL_WHALE_MIN_VOLUME_ETH = 500;

/**
 * Strong CEX signal only if ≥3 CEX counterparties OR ≥30% volume share with CEX (not bridge).
 */
function hasStrongCexSignal(features) {
  const beh = features?.behavioral_metrics || {};
  const cexCp = beh.cex_counterparty_count ?? 0;
  const cexShare = beh.cex_volume_share ?? 0;
  return cexCp >= CEX_MIN_CP_FOR_STRONG || cexShare >= CEX_MIN_VOLUME_SHARE;
}

/**
 * Count txs with gas price ≥ 2× wallet median (network-style spike).
 */
function countGas2xMedianTxs(txs) {
  const gasPrices = (txs || []).map((t) => parseInt(t.gasPrice, 10)).filter((g) => g > 0);
  if (gasPrices.length < 5) return 0;
  const sorted = [...gasPrices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 2;
  return gasPrices.filter((g) => g >= threshold).length;
}

/**
 * MEV: require at least 3 of: same-block ≥3 repeatedly, DEX >50%, gas ≥2× median, burst repeated weekly.
 */
function countMevSignals(features, txs) {
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  let count = 0;
  if ((beh.same_block_3_plus_count ?? 0) >= MEV_SAME_BLOCK_3_PLUS_MIN) count++;
  if ((beh.dex_interaction_ratio ?? 0) > MEV_DEX_DOMINANCE) count++;
  if (countGas2xMedianTxs(txs) >= MEV_GAS_2X_MEDIAN_MIN_TXS) count++;
  if ((tem.burst_activity_score ?? 0) > 0 && (beh.weekly_burst_count ?? 0) >= 2) count++;
  return count;
}

/**
 * Classification: strict ALL for CEX; at least 3 signals for MEV; multiple large + custody + low DEX + dormancy for Fund;
 * Individual Whale only with volume > threshold and no other winner; else Unknown.
 */
export function classifyEntity(features, txs, fundingAnalysis) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  const totalTxs = (txs || []).length;
  const walletAgeDays = act.wallet_age_days ?? 0;
  const lifetimeEth = vol.lifetime_volume_eth ?? 0;
  const uniqueCp = net.unique_counterparties ?? 0;

  const strongCex = hasStrongCexSignal(features);
  const batchedWithdrawals = (beh.same_block_3_plus_count ?? 0) >= MEV_SAME_BLOCK_3_PLUS_MIN;

  // ─── CEX Hot Wallet: require ALL ───
  const cexTxs = totalTxs > CEX_MIN_TXS;
  const cexCp = uniqueCp > CEX_MIN_COUNTERPARTIES;
  const cexAge = walletAgeDays >= CEX_MIN_AGE_DAYS;
  const cexBatched = batchedWithdrawals;
  const cexVolumeShare = (beh.cex_volume_share ?? 0) >= CEX_MIN_VOLUME_SHARE;
  const cexAll =
    cexTxs && cexCp && cexAge && cexBatched && cexVolumeShare && strongCex;

  if (cexAll) {
    return {
      entity_type: "CEX Hot Wallet",
      entity_score: 0.75,
      signals_used: ["high_tx_count", "many_counterparties", "long_age", "batched_withdrawals", "high_cex_volume_share"],
      all_scores: { "CEX Hot Wallet": 0.75, "MEV Bot": 0, "Fund / Institutional Whale": 0, "Individual Whale": 0, Unknown: 0 },
    };
  }

  // ─── MEV Bot: require at least 3 of 4 signals ───
  const mevSignalCount = countMevSignals(features, txs);
  if (mevSignalCount >= MEV_MIN_SIGNALS_REQUIRED) {
    const signals = [];
    if ((beh.same_block_3_plus_count ?? 0) >= MEV_SAME_BLOCK_3_PLUS_MIN) signals.push("same_block_3_plus_repeatedly");
    if ((beh.dex_interaction_ratio ?? 0) > MEV_DEX_DOMINANCE) signals.push("dex_dominance_50_plus");
    if (countGas2xMedianTxs(txs) >= MEV_GAS_2X_MEDIAN_MIN_TXS) signals.push("gas_2x_median");
    if ((tem.burst_activity_score ?? 0) > 0 && (beh.weekly_burst_count ?? 0) >= 2) signals.push("burst_repeated_weekly");
    const mevScore = Math.min(1, Math.round((0.65 + mevSignalCount * 0.08) * 100) / 100);
    return {
      entity_type: "MEV Bot",
      entity_score: mevScore,
      signals_used: signals,
      all_scores: { "CEX Hot Wallet": 0, "MEV Bot": mevScore, "Fund / Institutional Whale": 0, "Individual Whale": 0, Unknown: 0 },
    };
  }

  // ─── Fund / Institutional: multiple large transfers, custody (CEX only), low DEX, long dormancy ───
  const largeTxCount = (txs || []).filter((t) => toEth(t.value) >= FUND_LARGE_TX_ETH).length;
  const fundMultipleLarge = largeTxCount >= FUND_MIN_LARGE_TXS;
  const fundCustody = strongCex && (beh.cex_volume_share ?? 0) >= 0.1;
  const fundLowDex = (beh.dex_interaction_ratio ?? 0) < 0.2;
  const fundDormancy = walletAgeDays > FUND_MIN_AGE_DAYS && (act.avg_tx_per_day ?? 0) < 1;
  if (fundMultipleLarge && fundCustody && fundLowDex && fundDormancy) {
    return {
      entity_type: "Fund / Institutional Whale",
      entity_score: 0.7,
      signals_used: ["multiple_large_transfers", "custody_cex", "low_dex_ratio", "long_dormancy"],
      all_scores: { "CEX Hot Wallet": 0, "MEV Bot": 0, "Fund / Institutional Whale": 0.7, "Individual Whale": 0, Unknown: 0 },
    };
  }

  // ─── Individual Whale: only if lifetime volume > threshold; no default 0.5 ───
  if (lifetimeEth >= INDIVIDUAL_WHALE_MIN_VOLUME_ETH && totalTxs >= 5 && !cexAll && mevSignalCount < MEV_MIN_SIGNALS_REQUIRED && !(fundMultipleLarge && fundCustody)) {
    return {
      entity_type: "Individual Whale",
      entity_score: 0.55,
      signals_used: ["lifetime_volume_above_threshold", "no_cex_mev_fund_pattern"],
      all_scores: { "CEX Hot Wallet": 0, "MEV Bot": 0, "Fund / Institutional Whale": 0, "Individual Whale": 0.55, Unknown: 0 },
    };
  }

  return {
    entity_type: "Unknown",
    entity_score: 0,
    signals_used: [],
    all_scores: { "CEX Hot Wallet": 0, "MEV Bot": 0, "Fund / Institutional Whale": 0, "Individual Whale": 0, Unknown: 0 },
  };
}

export { ENTITY_TYPES };
