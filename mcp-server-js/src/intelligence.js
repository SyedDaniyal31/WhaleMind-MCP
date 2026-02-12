/**
 * Wallet intelligence engine — funding analysis and coordination detection.
 * Heuristic-based, deterministic, explainable. No ML.
 * Known labels (CEX, DEX) from knownLabels.js.
 */

import { createHash } from "node:crypto";
import { KNOWN_CEX_AND_BRIDGES, KNOWN_DEX_ROUTERS } from "./knownLabels.js";

// Minimum ETH to consider "large" (whale/fund-like)
const LARGE_TX_ETH = 50;
// Small deposit threshold (CEX hot wallet pattern)
const SMALL_DEPOSIT_ETH = 2;
// Time window for temporal coordination (seconds)
const COORDINATION_WINDOW = 600; // 10 minutes

// ─── STRICT classification thresholds (minimize false positives) ───
const CEX_MIN_TXS = 1001;
const CEX_MIN_COUNTERPARTIES = 201;
const CEX_MIN_VOLUME_ETH = 5000;
const CEX_MIN_ACTIVITY_MONTHS = 6;

const LOW_ACTIVITY_MAX_TXS = 200;
const LOW_ACTIVITY_MAX_COUNTERPARTIES = 50;
const LOW_VOLUME_ETH = 500; // below this = "low volume" for Unknown Entity

const MEV_MIN_DEX_INTERACTIONS = 8;
const MEV_MIN_SAME_BLOCK_TXS = 2; // at least one block with 2+ txs from this wallet
const GAS_SPIKE_MULTIPLIER = 1.5; // gas above median * this = spike vs "network"

const CONFIDENCE_PENALTY_LIMITED_HISTORY_TXS = 500;
const CONFIDENCE_PENALTY_LOW_VOLUME_ETH = 1000;
const CONFIDENCE_PENALTY_MIN_ACTIVITY_MONTHS = 3;

/**
 * Analyze funding sources: who sent money to this wallet.
 * Flags CEX/bridge funders. Used for clustering (shared funding) and profiling.
 */
export function analyzeFundingSources(txs, internalTxs, address) {
  const low = (address || "").toLowerCase();
  const funders = new Map(); // addr -> { count, totalEth, firstTs, lastTs }
  const signals = [];

  const toEth = (val) => {
    if (val == null) return 0;
    if (typeof val === "number" && !Number.isNaN(val)) return val;
    const s = String(val);
    if (s.startsWith("0x")) return Number(BigInt(s)) / 1e18;
    return Number(s) || 0;
  };
  const considerInbound = (from, valueEth, ts) => {
    if (!from || from === low) return;
    const f = from.toLowerCase();
    const v = typeof valueEth === "number" ? valueEth : toEth(valueEth);
    const t = ts != null ? parseInt(ts, 10) : 0;
    if (!funders.has(f)) funders.set(f, { count: 0, totalEth: 0, firstTs: t, lastTs: t });
    const rec = funders.get(f);
    rec.count += 1;
    rec.totalEth += v;
    if (t) rec.firstTs = Math.min(rec.firstTs || t, t);
    rec.lastTs = Math.max(rec.lastTs, t);
  };

  for (const tx of txs || []) {
    const to = (tx.to || "").toLowerCase();
    if (to !== low) continue;
    const from = (tx.from || "").toLowerCase();
    const valueEth = Number(tx.value) / 1e18;
    considerInbound(from, valueEth, tx.timeStamp);
  }
  for (const tx of internalTxs || []) {
    const to = (tx.to || "").toLowerCase();
    if (to !== low) continue;
    const from = (tx.from || "").toLowerCase();
    const valueEth = toEth(tx.value);
    considerInbound(from, valueEth, tx.timeStamp);
  }

  const cexOrBridgeFunders = [];
  for (const [addr] of funders) {
    if (KNOWN_CEX_AND_BRIDGES.has(addr)) cexOrBridgeFunders.push(addr);
  }
  if (cexOrBridgeFunders.length > 0) {
    signals.push("shared_funding_cex_bridge");
  }
  if (funders.size >= 1) {
    signals.push("has_funding_sources");
  }

  return {
    funders: Array.from(funders.entries()).map(([addr, r]) => ({
      address: addr,
      count: r.count,
      totalEth: Math.round(r.totalEth * 1e4) / 1e4,
      firstTs: r.firstTs,
      lastTs: r.lastTs,
    })),
    cexOrBridgeFunders,
    signals,
  };
}

/**
 * Detect coordination: connected wallets (internal tx counterparties), temporal bursts,
 * shared counterparty patterns. Deterministic.
 */
export function detectCoordination(txs, internalTxs, address) {
  const low = (address || "").toLowerCase();
  const connectedSet = new Set();
  const temporalSignals = [];
  const sharedCounterpartySignals = [];

  // Connected wallets: addresses that appear in internal txs with this wallet
  for (const tx of internalTxs || []) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    if (from === low && to) connectedSet.add(to);
    if (to === low && from) connectedSet.add(from);
  }
  // Normal txs: direct counterparties (we already have many; "small set" = few unique)
  const outboundCounterparties = new Map();
  for (const tx of txs || []) {
    if ((tx.from || "").toLowerCase() !== low) continue;
    const to = (tx.to || "").toLowerCase();
    if (!to) continue;
    outboundCounterparties.set(to, (outboundCounterparties.get(to) || 0) + 1);
  }

  // Temporal: group txs by time windows; if many txs in a short window, rotating capital pattern
  const sortedTs = (txs || [])
    .map((t) => parseInt(t.timeStamp, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  for (let i = 0; i < sortedTs.length; i++) {
    const t = sortedTs[i];
    let count = 1;
    while (i + count < sortedTs.length && sortedTs[i + count] - t <= COORDINATION_WINDOW) count++;
    if (count >= 3) {
      temporalSignals.push("temporal_burst");
      break;
    }
  }

  // Shared counterparties: if this wallet interacts with a small set repeatedly
  const uniqueOut = outboundCounterparties.size;
  const totalOut = (txs || []).filter((t) => (t.from || "").toLowerCase() === low).length;
  if (uniqueOut >= 1 && totalOut >= 3 && uniqueOut <= 5) {
    sharedCounterpartySignals.push("small_repeated_counterparties");
  }

  return {
    connectedWallets: Array.from(connectedSet),
    temporalSignals,
    sharedCounterpartySignals,
  };
}

/**
 * Behavioral similarity metrics from tx list: gas strategy, timing, contract usage,
 * same-block patterns, gas spikes. Used for MEV and confidence penalties.
 */
function behavioralMetrics(txs, address) {
  const low = (address || "").toLowerCase();
  const gasPrices = [];
  const timestamps = [];
  const blockCounts = new Map(); // blockNumber -> count of txs from this wallet
  let contractInteractionCount = 0;
  let dexOrMevInteractionCount = 0;
  let largeTxCount = 0;
  let smallInboundCount = 0;
  let totalInboundEth = 0;

  const toEth = (val) => {
    if (val == null) return 0;
    if (typeof val === "number" && !Number.isNaN(val)) return val;
    const s = String(val);
    if (s.startsWith("0x")) return Number(BigInt(s)) / 1e18;
    return Number(s) / 1e18 || 0;
  };
  for (const tx of txs || []) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    const valueEth = toEth(tx.value);
    const ts = parseInt(tx.timeStamp, 10);
    const block = tx.blockNumber != null ? String(tx.blockNumber) : null;
    if (!Number.isNaN(ts)) timestamps.push(ts);
    if (from === low && block) {
      blockCounts.set(block, (blockCounts.get(block) || 0) + 1);
    }
    const gp = parseInt(tx.gasPrice, 10) || 0;
    if (gp > 0) gasPrices.push(gp);
    const hasInput = tx.input && tx.input.length > 10;
    if (to && hasInput) contractInteractionCount++;
    if (KNOWN_DEX_ROUTERS.has(to)) dexOrMevInteractionCount++;
    if (valueEth >= LARGE_TX_ETH) largeTxCount++;
    if (from !== low && to === low && valueEth > 0 && valueEth <= SMALL_DEPOSIT_ETH) smallInboundCount++;
    if (to === low) totalInboundEth += valueEth;
  }

  timestamps.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const gasVariance = gasPrices.length
    ? (() => {
        const avg = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
        const variance = gasPrices.reduce((s, g) => s + (g - avg) ** 2, 0) / gasPrices.length;
        return Math.sqrt(variance) / (avg || 1);
      })()
    : 0;

  const sameBlockCounts = Array.from(blockCounts.values());
  const maxSameBlock = sameBlockCounts.length ? Math.max(...sameBlockCounts) : 0;
  const hasSameBlockMultiTx = maxSameBlock >= MEV_MIN_SAME_BLOCK_TXS;

  const sortedGas = [...gasPrices].sort((a, b) => a - b);
  const medianGas = sortedGas.length ? sortedGas[Math.floor(sortedGas.length / 2)] : 0;
  const gasSpikeThreshold = medianGas * GAS_SPIKE_MULTIPLIER;
  const hasGasSpikes = gasPrices.length >= 5 && gasPrices.filter((g) => g >= gasSpikeThreshold).length >= 2;

  return {
    totalTxs: (txs || []).length,
    gasPriceCount: gasPrices.length,
    gasVarianceNorm: gasVariance,
    contractInteractionCount,
    dexOrMevInteractionCount,
    largeTxCount,
    smallInboundCount,
    totalInboundEth,
    avgIntervalSeconds: Math.round(avgInterval),
    hasBurstTiming: intervals.some((d) => d <= 60) && intervals.length >= 5,
    hasSameBlockMultiTx,
    hasGasSpikes,
    medianGasPrice: medianGas,
  };
}

/** Activity span in months from first_seen_iso and last_seen_iso. Returns 0 if missing. */
function activitySpanMonths(firstIso, lastIso) {
  if (!firstIso || !lastIso) return 0;
  try {
    const first = new Date(firstIso).getTime();
    const last = new Date(lastIso).getTime();
    if (Number.isNaN(first) || Number.isNaN(last) || last <= first) return 0;
    return (last - first) / (1000 * 60 * 60 * 24 * 30.44);
  } catch {
    return 0;
  }
}

/** Apply confidence penalties for limited history, low volume, short activity window. */
function applyConfidencePenalties(baseConfidence, summary, reasoning) {
  let c = baseConfidence;
  if (summary.total_txs < CONFIDENCE_PENALTY_LIMITED_HISTORY_TXS) {
    c -= 0.15;
    reasoning.push("limited_tx_history");
  }
  const volume = (summary.total_in_eth || 0) + (summary.total_out_eth || 0);
  if (volume < CONFIDENCE_PENALTY_LOW_VOLUME_ETH) {
    c -= 0.1;
    reasoning.push("low_volume");
  }
  const months = activitySpanMonths(summary.first_seen_iso, summary.last_seen_iso);
  if (months < CONFIDENCE_PENALTY_MIN_ACTIVITY_MONTHS && months > 0) {
    c -= 0.1;
    reasoning.push("recent_only_activity");
  }
  return Math.max(0.1, Math.min(1, c));
}

/**
 * Classify wallet behavior with STRICT rules to minimize false positives.
 * Returns type, confidence (0–1), reasoning array.
 * When unsure → "Unclassified".
 *
 * @param {Array} txs - Normal transactions (used for behavioral metrics)
 * @param {Object} fundingAnalysis - From analyzeFundingSources
 * @param {Object} coordination - From detectCoordination
 * @param {string} address - Wallet address
 * @param {Object} summary - { total_txs, unique_counterparties, total_in_eth, total_out_eth, first_seen_iso, last_seen_iso }
 */
export function classifyBehavior(txs, fundingAnalysis, coordination, address, summary = {}) {
  const m = behavioralMetrics(txs, address);
  const reasoning = [];
  const totalTxs = summary.total_txs ?? m.totalTxs;
  const uniqueCounterparties = summary.unique_counterparties ?? 0;
  const totalIn = Number(summary.total_in_eth) || 0;
  const totalOut = Number(summary.total_out_eth) || 0;
  const volumeEth = totalIn + totalOut;
  const activityMonths = activitySpanMonths(summary.first_seen_iso, summary.last_seen_iso);

  // ─── 1) CEX: ONLY if ALL strict thresholds are met; otherwise DO NOT label CEX ───
  const cexTxsOk = totalTxs > CEX_MIN_TXS;
  const cexCounterpartiesOk = uniqueCounterparties > CEX_MIN_COUNTERPARTIES;
  const cexVolumeOk = volumeEth > CEX_MIN_VOLUME_ETH;
  const cexActivityOk = activityMonths >= CEX_MIN_ACTIVITY_MONTHS;
  if (cexTxsOk && cexCounterpartiesOk && cexVolumeOk && cexActivityOk) {
    const hasKnownExchange = (fundingAnalysis?.cexOrBridgeFunders?.length || 0) > 0;
    if (hasKnownExchange) {
      let confidence = 0.75;
      reasoning.push("high_tx_count", "high_counterparties", "high_volume", "long_activity", "known_exchange_interaction");
      confidence = applyConfidencePenalties(confidence, summary, reasoning);
      return { type: "CEX Hot Wallet", confidence, reasoning };
    }
  }

  // ─── 2) Low activity → Individual Whale / Unknown Entity ───
  if (
    totalTxs < LOW_ACTIVITY_MAX_TXS &&
    uniqueCounterparties < LOW_ACTIVITY_MAX_COUNTERPARTIES &&
    volumeEth < LOW_VOLUME_ETH
  ) {
    reasoning.push("low_tx_count", "low_counterparties", "low_volume");
    let confidence = 0.5;
    confidence = applyConfidencePenalties(confidence, summary, reasoning);
    return { type: "Individual Whale / Unknown Entity", confidence, reasoning };
  }

  // ─── 3) MEV: requires repeated DEX interaction + same-block multi-tx + gas spikes ───
  const mevDexOk = m.dexOrMevInteractionCount >= MEV_MIN_DEX_INTERACTIONS;
  const mevSameBlockOk = m.hasSameBlockMultiTx;
  const mevGasOk = m.hasGasSpikes;
  if (mevDexOk && mevSameBlockOk && mevGasOk) {
    reasoning.push("repeated_dex_router_interaction", "same_block_multi_tx", "gas_price_spikes");
    let confidence = 0.7;
    confidence = applyConfidencePenalties(confidence, summary, reasoning);
    return { type: "MEV Bot", confidence, reasoning };
  }

  // ─── 4) Fund-like: large txs, low frequency, sufficient history (avoid guessing) ───
  if (m.largeTxCount >= 2 && totalTxs <= 80 && totalTxs >= 5 && activityMonths >= 2) {
    const hasKnownExchange = (fundingAnalysis?.cexOrBridgeFunders?.length || 0) > 0;
    reasoning.push("large_value_txs", "low_frequency");
    if (hasKnownExchange) reasoning.push("bridge_or_cex_usage");
    let confidence = 0.55;
    confidence = applyConfidencePenalties(confidence, summary, reasoning);
    if (confidence >= 0.4) return { type: "Fund-like", confidence, reasoning };
  }

  // ─── 5) When unsure → Unclassified (minimize false positives) ───
  if (totalTxs < 100 || volumeEth < 200) {
    reasoning.push("insufficient_data", "avoid_false_positive");
    const confidence = Math.max(0.15, 0.5 - (100 - totalTxs) / 500);
    return { type: "Unclassified", confidence, reasoning };
  }

  // Default: Individual Whale / Unknown Entity with penalties
  reasoning.push("no_strong_pattern", "default_conservative");
  let confidence = 0.45;
  confidence = applyConfidencePenalties(confidence, summary, reasoning);
  return { type: "Individual Whale / Unknown Entity", confidence, reasoning };
}

/**
 * Build entity cluster output: deterministic cluster_id, confidence, connected_wallets, signals_used.
 */
export function buildEntityCluster(address, fundingAnalysis, coordination) {
  const signals = [];
  const connected = coordination?.connectedWallets || [];
  if ((fundingAnalysis?.signals || []).includes("shared_funding_cex_bridge")) {
    signals.push("shared_funding_cex_bridge");
  }
  if ((fundingAnalysis?.signals || []).includes("has_funding_sources")) {
    signals.push("has_funding_sources");
  }
  for (const s of coordination?.temporalSignals || []) signals.push(s);
  for (const s of coordination?.sharedCounterpartySignals || []) signals.push(s);

  let clusterId = null;
  let clusterConfidence = 0;
  if (connected.length > 0) {
    clusterConfidence = Math.min(0.95, 0.4 + connected.length * 0.1 + signals.length * 0.05);
    const seed = [address.toLowerCase(), ...connected.map((a) => a.toLowerCase()).sort()].join("|");
    clusterId = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  } else if (signals.length > 0) {
    clusterConfidence = 0.3 + signals.length * 0.1;
    clusterId = createHash("sha256").update(`${address.toLowerCase()}|${signals.sort().join("|")}`).digest("hex").slice(0, 16);
  }

  return {
    cluster_id: clusterId,
    confidence: Math.round(clusterConfidence * 100) / 100,
    connected_wallets: connected,
    signals_used: [...new Set(signals)],
  };
}
