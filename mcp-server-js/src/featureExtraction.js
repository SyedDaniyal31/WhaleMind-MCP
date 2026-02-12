/**
 * Phase 1 — Feature extraction layer.
 * All metrics derived from on-chain data (txs + internalTxs). No fabrication.
 */

import { KNOWN_CEX, KNOWN_CEX_AND_BRIDGES, KNOWN_DEX_ROUTERS } from "./knownLabels.js";

// Hardening: round numbers only >= 10 ETH; same-block threshold >= 3; burst meaningful only if repeated weekly
const ROUND_NUMBER_MIN_ETH = 10;
const SAME_BLOCK_MIN_TXS = 3;
const BURST_MIN_TXS_IN_WINDOW = 3;
const BURST_WINDOW_SEC = 600;
const MIN_WEEKS_BURST_FOR_SIGNAL = 2;

const WEI_PER_ETH = 1e18;

function toEth(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const s = String(val);
  if (s.startsWith("0x")) return Number(BigInt(s)) / WEI_PER_ETH;
  return Number(s) / WEI_PER_ETH || 0;
}

function parseTs(tx) {
  const ts = tx.timeStamp != null ? parseInt(tx.timeStamp, 10) : null;
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Compute feature summary from normal + internal txs for one wallet.
 * @param {Array} txs - Normal transactions
 * @param {Array} internalTxs - Internal transactions
 * @param {string} address - Wallet address (0x...)
 * @returns {Object} feature_summary with activity, volume, network, behavioral, temporal metrics
 */
export function extractFeatures(txs, internalTxs, address) {
  const low = (address || "").toLowerCase();
  const allTxLike = [...(txs || []), ...(internalTxs || []).map((it) => ({ ...it, from: it.from, to: it.to, value: it.value, timeStamp: it.timeStamp, blockNumber: it.blockNumber, input: "" }))];

  const outbound = (txs || []).filter((t) => (t.from || "").toLowerCase() === low);
  const inbound = (txs || []).filter((t) => (t.to || "").toLowerCase() === low);
  const totalTxs = (txs || []).length;
  if (totalTxs === 0) {
    return emptyFeatureSummary();
  }

  const timestamps = (txs || []).map(parseTs).filter((t) => t != null);
  timestamps.sort((a, b) => a - b);
  const firstTs = timestamps[0];
  const lastTs = timestamps[timestamps.length - 1];
  const walletAgeSeconds = firstTs && lastTs ? lastTs - firstTs : 0;
  const wallet_age_days = Math.round((walletAgeSeconds / 86400) * 100) / 100;

  const uniqueDays = new Set(timestamps.map((t) => Math.floor(t / 86400))).size;
  const spanDays = wallet_age_days || 1;
  const active_days_ratio = spanDays > 0 ? Math.min(1, Math.round((uniqueDays / spanDays) * 1000) / 1000) : 0;

  const avg_tx_per_day = spanDays > 0 ? Math.round((totalTxs / spanDays) * 1000) / 1000 : 0;

  const txsPerDay = new Map();
  for (const t of timestamps) {
    const d = Math.floor(t / 86400);
    txsPerDay.set(d, (txsPerDay.get(d) || 0) + 1);
  }
  const dailyCounts = Array.from(txsPerDay.values());
  const meanDaily = dailyCounts.length ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0;
  const variance = dailyCounts.length ? dailyCounts.reduce((s, c) => s + (c - meanDaily) ** 2, 0) / dailyCounts.length : 0;
  const tx_frequency_std_dev = Math.round(Math.sqrt(variance) * 1000) / 1000;

  let totalInEth = 0,
    totalOutEth = 0;
  const valuesEth = [];
  for (const tx of txs || []) {
    const v = toEth(tx.value);
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    if (from === low) {
      totalOutEth += v;
      if (v > 0) valuesEth.push(v);
    }
    if (to === low) {
      totalInEth += v;
      if (v > 0) valuesEth.push(v);
    }
  }
  const lifetime_volume_eth = Math.round((totalInEth + totalOutEth) * 1000) / 1000;
  const avg_tx_size = valuesEth.length ? Math.round((valuesEth.reduce((a, b) => a + b, 0) / valuesEth.length) * 1000) / 1000 : 0;
  const sorted = [...valuesEth].sort((a, b) => a - b);
  const median_tx_size = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000 : 0;
  const max_single_tx = sorted.length ? Math.round(sorted[sorted.length - 1] * 1000) / 1000 : 0;

  const counterparties = new Map();
  for (const tx of txs || []) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    if (from === low && to) counterparties.set(to, (counterparties.get(to) || 0) + 1);
    if (to === low && from) counterparties.set(from, (counterparties.get(from) || 0) + 1);
  }
  const unique_counterparties = counterparties.size;
  const totalCpTxs = Array.from(counterparties.values()).reduce((a, b) => a + b, 0);
  const repeat_counterparty_ratio = totalCpTxs > 0 ? Math.round((1 - unique_counterparties / totalCpTxs) * 1000) / 1000 : 0;
  const sortedByVolume = Array.from(counterparties.entries()).sort((a, b) => b[1] - a[1]);
  const top5Count = sortedByVolume.slice(0, 5).reduce((s, [, c]) => s + c, 0);
  const top_5_counterparty_share = totalCpTxs > 0 ? Math.round((top5Count / totalCpTxs) * 1000) / 1000 : 0;

  let dexCount = 0,
    cexCount = 0,
    contractCallCount = 0;
  const blockCounts = new Map();
  const cexCounterparties = new Set();
  let volumeWithCex = 0;
  let roundNumber10EthCount = 0;
  for (const tx of txs || []) {
    const to = (tx.to || "").toLowerCase();
    const from = (tx.from || "").toLowerCase();
    const v = toEth(tx.value);
    if ((from === low || to === low) && to && KNOWN_DEX_ROUTERS.has(to)) dexCount++;
    if ((from === low || to === low) && to && KNOWN_CEX_AND_BRIDGES.has(to)) cexCount++;
    if ((from === low || to === low) && from && KNOWN_CEX_AND_BRIDGES.has(from)) cexCount++;
    if (to && KNOWN_CEX.has(to)) cexCounterparties.add(to);
    if (from && KNOWN_CEX.has(from)) cexCounterparties.add(from);
    if (from === low && to && KNOWN_CEX.has(to)) volumeWithCex += v;
    if (to === low && from && KNOWN_CEX.has(from)) volumeWithCex += v;
    if (v >= ROUND_NUMBER_MIN_ETH) {
      const rounded = Math.round(v);
      if (Math.abs(v - rounded) < 0.001) roundNumber10EthCount++;
    }
    const hasInput = tx.input && tx.input.length > 10;
    if ((from === low || to === low) && to && hasInput) contractCallCount++;
    if (from === low && tx.blockNumber) blockCounts.set(String(tx.blockNumber), (blockCounts.get(String(tx.blockNumber)) || 0) + 1);
  }
  const dex_interaction_ratio = totalTxs > 0 ? Math.round((dexCount / totalTxs) * 1000) / 1000 : 0;
  const cex_interaction_ratio = totalTxs > 0 ? Math.round((cexCount / totalTxs) * 1000) / 1000 : 0;
  const contract_call_ratio = totalTxs > 0 ? Math.round((contractCallCount / totalTxs) * 1000) / 1000 : 0;
  const same_block_multi_tx_count = Array.from(blockCounts.values()).filter((c) => c >= SAME_BLOCK_MIN_TXS).length;
  const same_block_3_plus_count = same_block_multi_tx_count;
  const cex_counterparty_count = cexCounterparties.size;
  const totalVolume = totalInEth + totalOutEth;
  const cex_volume_share = totalVolume > 0 ? Math.round((volumeWithCex / totalVolume) * 1000) / 1000 : 0;

  const weeksWithBurst = new Set();
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    let count = 1;
    while (i + count < timestamps.length && timestamps[i + count] - t <= BURST_WINDOW_SEC) count++;
    if (count >= BURST_MIN_TXS_IN_WINDOW) {
      const weekStart = Math.floor(t / (86400 * 7));
      weeksWithBurst.add(weekStart);
    }
  }
  const weekly_burst_count = weeksWithBurst.size;
  let burstScore = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    let count = 1;
    while (i + count < timestamps.length && timestamps[i + count] - t <= BURST_WINDOW_SEC) count++;
    if (count >= BURST_MIN_TXS_IN_WINDOW) burstScore += count;
  }
  const burst_activity_score =
    weekly_burst_count >= MIN_WEEKS_BURST_FOR_SIGNAL ? Math.round(Math.min(1, burstScore / 20) * 1000) / 1000 : 0;

  const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const t of timestamps) {
    const d = new Date(t * 1000).getUTCDay();
    dayOfWeekCounts[d]++;
  }
  const maxDay = Math.max(...dayOfWeekCounts);
  const weekly_activity_pattern = totalTxs > 0 ? dayOfWeekCounts.map((c) => Math.round((c / totalTxs) * 1000) / 1000) : [0, 0, 0, 0, 0, 0, 0];

  return {
    activity_metrics: {
      wallet_age_days,
      active_days_ratio,
      avg_tx_per_day,
      tx_frequency_std_dev,
    },
    volume_metrics: {
      lifetime_volume_eth,
      avg_tx_size,
      median_tx_size,
      max_single_tx,
    },
    network_metrics: {
      unique_counterparties,
      repeat_counterparty_ratio,
      top_5_counterparty_share,
    },
    behavioral_metrics: {
      dex_interaction_ratio,
      cex_interaction_ratio,
      contract_call_ratio,
      same_block_multi_tx_count,
      same_block_3_plus_count,
      cex_counterparty_count,
      cex_volume_share,
      round_number_transfers_10eth: roundNumber10EthCount,
      weekly_burst_count: weekly_burst_count,
    },
    temporal_metrics: {
      burst_activity_score,
      weekly_activity_pattern,
    },
  };
}

function emptyFeatureSummary() {
  return {
    activity_metrics: {
      wallet_age_days: 0,
      active_days_ratio: 0,
      avg_tx_per_day: 0,
      tx_frequency_std_dev: 0,
    },
    volume_metrics: {
      lifetime_volume_eth: 0,
      avg_tx_size: 0,
      median_tx_size: 0,
      max_single_tx: 0,
    },
    network_metrics: {
      unique_counterparties: 0,
      repeat_counterparty_ratio: 0,
      top_5_counterparty_share: 0,
    },
    behavioral_metrics: {
      dex_interaction_ratio: 0,
      cex_interaction_ratio: 0,
      contract_call_ratio: 0,
      same_block_multi_tx_count: 0,
      same_block_3_plus_count: 0,
      cex_counterparty_count: 0,
      cex_volume_share: 0,
      round_number_transfers_10eth: 0,
      weekly_burst_count: 0,
    },
    temporal_metrics: {
      burst_activity_score: 0,
      weekly_activity_pattern: [0, 0, 0, 0, 0, 0, 0],
    },
  };
}
