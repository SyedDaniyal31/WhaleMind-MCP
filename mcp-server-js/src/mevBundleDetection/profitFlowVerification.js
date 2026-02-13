/**
 * Profit flow verification.
 * Heuristic: balance/token delta across sequence, implied arbitrage profit from DEX-like logs.
 * No real balance state; uses value flows and token transfer logs when available.
 */

const WEI_PER_ETH = 1e18;

function toEth(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const s = String(val);
  if (s.startsWith("0x")) return Number(BigInt(s)) / WEI_PER_ETH;
  return Number(s) / WEI_PER_ETH || 0;
}

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

/**
 * Aggregate net ETH value flow for a set of txs from a given address perspective.
 */
function netEthFlow(txs, fromAddress) {
  const addr = low(fromAddress);
  let net = 0;
  for (const tx of txs || []) {
    const from = low(tx.from);
    const to = low(tx.to);
    const v = toEth(tx.value);
    if (from === addr) net -= v;
    if (to === addr) net += v;
  }
  return net;
}

/**
 * Token delta from logs/tokenTransfers for an address (heuristic: Transfer events).
 */
function tokenDelta(txs, forAddress) {
  const addr = low(forAddress);
  const deltas = new Map();
  for (const tx of txs || []) {
    const logs = tx.logs || tx.tokenTransfers || [];
    for (const log of logs) {
      const token = (log.address || log.contractAddress || "").toLowerCase();
      if (!token) continue;
      const amount = log.value != null ? Number(BigInt(log.value)) : (log.amount != null ? Number(log.amount) : 0);
      const from = low(log.from);
      const to = low(log.to);
      if (!deltas.has(token)) deltas.set(token, 0);
      if (from === addr) deltas.set(token, deltas.get(token) - amount);
      if (to === addr) deltas.set(token, deltas.get(token) + amount);
    }
  }
  return deltas;
}

/**
 * Compute profit_score for a candidate bundle: net positive flow to a single executor-like address.
 */
export function computeProfitFlow(txs, startIndex, endIndex) {
  const list = txs || [];
  const slice = list.slice(Math.max(0, startIndex), Math.min(list.length, endIndex + 1));
  if (slice.length < 2) {
    return { profit_score: 0, net_eth_flow: 0, token_delta_count: 0 };
  }

  const senders = new Set(slice.map((t) => low(t.from)));
  let bestNet = 0;
  let bestSender = null;
  for (const from of senders) {
    const net = netEthFlow(slice, from);
    if (net > bestNet) {
      bestNet = net;
      bestSender = from;
    }
  }

  const ethFlowScore = bestNet > 0 ? Math.min(1, Math.log10(1 + bestNet * 10) / 4) : 0;
  const tokenDeltas = bestSender ? tokenDelta(slice, bestSender) : new Map();
  const tokenDeltaCount = tokenDeltas.size;
  const tokenScore = tokenDeltaCount > 0 ? Math.min(1, tokenDeltaCount / 5) * 0.5 : 0;
  const profit_score = Math.min(1, ethFlowScore + tokenScore);
  return {
    profit_score: Math.round(profit_score * 100) / 100,
    net_eth_flow: Math.round(bestNet * 1e6) / 1e6,
    token_delta_count: tokenDeltaCount,
  };
}
