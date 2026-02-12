/**
 * Wallet intelligence engine — entity clustering and behavioral profiling.
 * Heuristic-based, deterministic, explainable. No ML.
 */

import { createHash } from "node:crypto";

// ─── Known-address heuristics (short list; production could use external labels) ───
const KNOWN_CEX_AND_BRIDGES = new Set([
  "0x28c6c06298d514db089934071355e5743bf21d60", // Binance 14
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549", // Binance
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", // Binance
  "0x56eddb7aa87536c09ccc2793473599fd21a8d17a", // Binance 8
  "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8", // Binance 7
  "0xf977814e90da44bfa03b6295a0616a897441acec", // Binance hot
  "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503", // Binance
  "0x876eabf441b2ee5b5b0554fd502a8e0600950cfa", // Bitfinex
  "0x1151314c646ce4e0efd76d1af4760ae66a9fe30f", // FTX
  "0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2", // FTX
  "0xc098b2a3aa256d2140208c3de6543aaef5cd3a94", // Multichain bridge
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", // Polygon bridge
  "0xa0c68c638235ee32657e8f720a23cec1bfc77c77", // Polygon ERC20 bridge
].map((a) => a.toLowerCase()));

// DEX routers / common MEV-related contracts (heuristic)
const KNOWN_DEX_OR_MEV = new Set([
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", // Uniswap V2 Router
  "0xe592427a0aece92de3edee1f18e0157c05861564", // Uniswap V3 Router
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // Uniswap V3 Router 2
  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b", // Uniswap Universal Router
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff", // 0x Exchange
  "0x1111111254eeb25477b68fb85ed929f73a960582", // 1inch V5
  "0x111111125421ca6dc452d289314280a0f8842a65", // 1inch V4
  "0x880a8439ad9dc2b227b2c22f6f2bd4e2f2e6b0a", // Common sandwich router (example)
].map((a) => a.toLowerCase()));

// Minimum ETH to consider "large" (whale/fund-like)
const LARGE_TX_ETH = 50;
// Small deposit threshold (CEX hot wallet pattern)
const SMALL_DEPOSIT_ETH = 2;
// Time window for "same timeframe" funding (seconds)
const FUNDING_TIME_WINDOW = 86400 * 2; // 2 days
// Time window for temporal coordination (seconds)
const COORDINATION_WINDOW = 600; // 10 minutes
// Min txs in short window to consider "high frequency" / MEV
const HIGH_FREQ_MIN_TXS = 15;
// Min txs for CEX hot wallet
const CEX_HOT_MIN_TXS = 100;

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
 * Behavioral similarity metrics from tx list: gas strategy, timing, contract usage.
 */
function behavioralMetrics(txs, address) {
  const low = (address || "").toLowerCase();
  const gasPrices = [];
  const timestamps = [];
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
    if (!Number.isNaN(ts)) timestamps.push(ts);
    const gp = parseInt(tx.gasPrice, 10) || 0;
    if (gp > 0) gasPrices.push(gp);
    // Contract: has input data and/or to is not in our "EOA" heuristic (long input = contract call)
    const hasInput = tx.input && tx.input.length > 10;
    if (to && hasInput) contractInteractionCount++;
    if (KNOWN_DEX_OR_MEV.has(to)) dexOrMevInteractionCount++;
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
  };
}

/**
 * Classify wallet behavior: CEX Hot Wallet, MEV Bot, Fund-like, Individual Whale.
 * Deterministic rules, returns type, confidence (0–1), reasoning array.
 */
export function classifyBehavior(txs, fundingAnalysis, coordination, address) {
  const m = behavioralMetrics(txs, address);
  const reasoning = [];
  let type = "Individual Whale";
  let confidence = 0.5;

  // CEX Hot Wallet: very high tx count, many small inbound, known exchange interaction
  const hasKnownExchange = (fundingAnalysis?.cexOrBridgeFunders?.length || 0) > 0;
  const cexScore =
    (m.totalTxs >= CEX_HOT_MIN_TXS ? 0.4 : m.totalTxs >= 50 ? 0.2 : 0) +
    (m.smallInboundCount >= 20 ? 0.3 : m.smallInboundCount >= 5 ? 0.15 : 0) +
    (hasKnownExchange ? 0.3 : 0);
  if (cexScore >= 0.5) {
    type = "CEX Hot Wallet";
    confidence = Math.min(0.95, 0.5 + cexScore * 0.4);
    reasoning.push("high_tx_count", "many_small_inbound_deposits");
    if (hasKnownExchange) reasoning.push("known_exchange_interaction");
    return { type, confidence, reasoning };
  }

  // MEV Bot: high frequency, DEX router interaction, sandwich-like (burst) timing
  const mevScore =
    (m.totalTxs >= HIGH_FREQ_MIN_TXS ? 0.35 : m.totalTxs >= 8 ? 0.15 : 0) +
    (m.dexOrMevInteractionCount >= 5 ? 0.35 : m.dexOrMevInteractionCount >= 1 ? 0.2 : 0) +
    (m.hasBurstTiming ? 0.3 : 0);
  if (mevScore >= 0.5) {
    type = "MEV Bot";
    confidence = Math.min(0.95, 0.5 + mevScore * 0.4);
    reasoning.push("high_frequency_txs", "dex_router_interaction");
    if (m.hasBurstTiming) reasoning.push("sandwich_like_timing");
    return { type, confidence, reasoning };
  }

  // Fund / Whale: large value txs, low frequency, possibly bridge usage
  const fundScore =
    (m.largeTxCount >= 2 ? 0.4 : m.largeTxCount >= 1 ? 0.2 : 0) +
    (m.totalTxs <= 30 && m.totalTxs >= 1 ? 0.3 : m.totalTxs <= 100 ? 0.15 : 0) +
    (hasKnownExchange ? 0.2 : 0); // bridge/CEX as proxy for "cross-chain"
  if (fundScore >= 0.5) {
    type = "Fund-like";
    confidence = Math.min(0.9, 0.5 + fundScore * 0.35);
    reasoning.push("large_value_txs", "low_frequency");
    if (hasKnownExchange) reasoning.push("bridge_or_cex_usage");
    return { type, confidence, reasoning };
  }

  // Default: Individual Whale — medium tx count, large holdings, no strong automation signals
  reasoning.push("medium_tx_count", "no_automation_patterns");
  confidence = 0.55;
  return { type, confidence, reasoning };
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
