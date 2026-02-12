/**
 * WhaleMind MCP tools — wallet intelligence + attribution engine.
 * Entity clustering and behavioral profiling (heuristic-based).
 */
import {
  analyzeFundingSources,
  detectCoordination,
  classifyBehavior,
  buildEntityCluster,
} from "./intelligence.js";

const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";
const WEI_PER_ETH = 1e18;
const TIMEOUT_MS = 10000;
const INTERNAL_TX_LIMIT = 100;

export const TOOL_DEFINITIONS = [
  {
    name: "whale_intel_report",
    description:
      "Wallet intelligence + attribution: entity clustering, behavioral profile, risk, copy-trade signal, balance. Tier-S heuristic analysis (Nansen/Arkham-style).",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Ethereum address (0x...)",
          default: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          examples: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
        },
        limit: { type: "number", description: "Max transactions to analyze", default: 50 },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      description: "Whale intelligence report with entity cluster and behavioral profile",
      properties: {
        address: { type: "string" },
        verdict: { type: "string" },
        confidence: { type: "number" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"] },
        total_txs: { type: "number" },
        total_in_eth: { type: "number" },
        total_out_eth: { type: "number" },
        unique_counterparties: { type: "number" },
        balance_wei: { type: ["string", "null"] },
        agent_summary: { type: "string" },
        first_seen_iso: { type: ["string", "null"] },
        last_seen_iso: { type: ["string", "null"] },
        entity_cluster: {
          type: "object",
          properties: {
            cluster_id: { type: ["string", "null"] },
            confidence: { type: "number" },
            connected_wallets: { type: "array", items: { type: "string" } },
            signals_used: { type: "array", items: { type: "string" } },
          },
          required: ["cluster_id", "confidence", "connected_wallets", "signals_used"],
        },
        behavioral_profile: {
          type: "object",
          properties: {
            type: { type: "string" },
            confidence: { type: "number" },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["type", "confidence", "reasoning"],
        },
      },
      required: [
        "address",
        "risk_level",
        "copy_trade_signal",
        "total_txs",
        "total_in_eth",
        "total_out_eth",
        "unique_counterparties",
        "agent_summary",
        "entity_cluster",
        "behavioral_profile",
      ],
    },
  },
  {
    name: "compare_whales",
    description: "Compare 2–5 Ethereum wallets. Returns ranking, best_for_copy_trading, comparison_summary.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
          examples: [["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"]],
        },
      },
      required: ["addresses"],
    },
    outputSchema: {
      type: "object",
      properties: {
        wallets: { type: "array", items: { type: "object" } },
        ranking: { type: "array", items: { type: "string" } },
        best_for_copy_trading: { type: ["string", "null"] },
        comparison_summary: { type: "string" },
      },
      required: ["wallets", "ranking", "best_for_copy_trading", "comparison_summary"],
    },
  },
  {
    name: "whale_risk_snapshot",
    description: "Quick risk and copy-trade signal for one wallet.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Ethereum address (0x...)",
          default: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          examples: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"] },
        one_line_rationale: { type: "string" },
        agent_summary: { type: "string" },
      },
      required: ["address", "risk_level", "copy_trade_signal", "one_line_rationale", "agent_summary"],
    },
  },
];

function weiToEth(w) {
  try {
    return Number(BigInt(w || "0")) / WEI_PER_ETH;
  } catch {
    return 0;
  }
}

function getApiUrl() {
  return (process.env.WHALEMIND_API_URL || process.env.WHalemind_API_URL || "").replace(/\/$/, "");
}

function getEtherscanKey() {
  return process.env.ETHERSCAN_API_KEY || "";
}

async function fetchTransactions(address, limit = 20) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(Math.min(limit, 10000)),
    sort: "desc",
    ...(getEtherscanKey() && { apikey: getEtherscanKey() }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (data?.status !== "1" || data?.message !== "OK") return [];
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    clearTimeout(t);
    if (e?.name !== "AbortError") console.error("[Etherscan]", e?.message || e);
    return [];
  }
}

/** Internal transactions for clustering (connected wallets, funding). Single call, bounded. */
async function fetchInternalTransactions(address) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlistinternal",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(Math.min(INTERNAL_TX_LIMIT, 1000)),
    sort: "desc",
    ...(getEtherscanKey() && { apikey: getEtherscanKey() }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (data?.status !== "1" || data?.message !== "OK") return [];
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    clearTimeout(t);
    if (e?.name !== "AbortError") console.error("[Etherscan internal]", e?.message || e);
    return [];
  }
}

function analyzeTransactions(txs, addr) {
  let inEth = 0,
    outEth = 0;
  const cp = new Set();
  const ts = [];
  const low = (addr || "").toLowerCase();
  for (const tx of txs) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    const v = weiToEth(tx.value);
    if (tx.timeStamp != null) ts.push(parseInt(tx.timeStamp, 10));
    if (from === low) {
      outEth += v;
      if (to) cp.add(to);
    }
    if (to === low) {
      inEth += v;
      if (from) cp.add(from);
    }
  }
  const first = ts.length ? Math.min(...ts) : null;
  const last = ts.length ? Math.max(...ts) : null;
  return {
    total_txs: txs.length,
    total_in_eth: Math.round(inEth * 1e4) / 1e4,
    total_out_eth: Math.round(outEth * 1e4) / 1e4,
    unique_counterparties: cp.size,
    first_seen_iso: first != null ? new Date(first * 1000).toISOString() : null,
    last_seen_iso: last != null ? new Date(last * 1000).toISOString() : null,
  };
}

async function fetchWhaleMindAnalyze(addr) {
  const url = getApiUrl();
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ wallet: addr }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function fetchWhaleMindBalance(addr) {
  const url = getApiUrl();
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/wallet/${encodeURIComponent(addr)}/balance`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = res.ok ? await res.json() : null;
    return data?.balance_wei ?? null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

const VERDICT = {
  SMART_MONEY_ACCUMULATION: { risk: "LOW", signal: "STRONG_BUY", score: 90 },
  WHALE_DORMANT: { risk: "LOW", signal: "WATCH", score: 50 },
  NEUTRAL: { risk: "MEDIUM", signal: "NEUTRAL", score: 50 },
  EXCHANGE_ROTATION: { risk: "MEDIUM", signal: "WATCH", score: 35 },
  STEALTH_DISTRIBUTION: { risk: "HIGH", signal: "AVOID", score: 15 },
};

function fromVerdict(verdict, confidence) {
  const v = verdict || "NEUTRAL";
  const c = typeof confidence === "number" ? confidence : 0.5;
  const s = VERDICT[v] || VERDICT.NEUTRAL;
  let sig = s.signal;
  if (sig === "STRONG_BUY" && c < 0.7) sig = "BUY";
  return { risk_level: s.risk, copy_trade_signal: sig, smart_money_score: Math.round((s.score ?? 50) * c) };
}

function fromMetrics(m) {
  const net = (m.total_in_eth || 0) - (m.total_out_eth || 0);
  const flow = (m.total_in_eth || 0) + (m.total_out_eth || 0);
  const txs = m.total_txs || 0;
  const cps = m.unique_counterparties || 0;
  let risk = "MEDIUM",
    signal = "NEUTRAL",
    score = 50;
  if (txs >= 10 && net > 20 && flow > 50) {
    risk = "LOW";
    signal = "BUY";
    score = Math.min(85, 50 + Math.round(net / 10) + Math.min(txs, 20));
  } else if (txs >= 5 && net < -20) {
    risk = "HIGH";
    signal = "AVOID";
    score = Math.max(15, 50 - Math.round(Math.abs(net) / 10));
  } else if (txs >= 3 && cps >= 2) signal = "WATCH";
  return { risk_level: risk, copy_trade_signal: signal, smart_money_score: score };
}

function ensureObject(o) {
  if (o == null || typeof o !== "object" || Array.isArray(o)) return {};
  return JSON.parse(JSON.stringify(o));
}

/** Coerce to outputSchema types so structuredContent never fails validation (Context/disputes). */
function toNumber(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
function toStringOrNull(v) {
  if (v == null) return null;
  return String(v);
}

/**
 * Coerce a tool result to match outputSchema types exactly. Call before returning
 * structuredContent so responses never fail schema validation (avoid disputes).
 */
export function coerceToOutputSchema(toolName, data) {
  const d = ensureObject(data);
  if (toolName === "whale_intel_report") {
    const ec = d.entity_cluster && typeof d.entity_cluster === "object" ? d.entity_cluster : {};
    const bp = d.behavioral_profile && typeof d.behavioral_profile === "object" ? d.behavioral_profile : {};
    return {
      address: String(d.address ?? ""),
      ...(d.verdict != null && { verdict: String(d.verdict) }),
      ...(typeof d.confidence === "number" && !Number.isNaN(d.confidence) && { confidence: d.confidence }),
      risk_level: String(d.risk_level ?? "MEDIUM"),
      copy_trade_signal: String(d.copy_trade_signal ?? "NEUTRAL"),
      total_txs: toNumber(d.total_txs),
      total_in_eth: toNumber(d.total_in_eth),
      total_out_eth: toNumber(d.total_out_eth),
      unique_counterparties: toNumber(d.unique_counterparties),
      balance_wei: d.balance_wei == null ? null : String(d.balance_wei),
      agent_summary: String(d.agent_summary ?? ""),
      first_seen_iso: d.first_seen_iso == null ? null : String(d.first_seen_iso),
      last_seen_iso: d.last_seen_iso == null ? null : String(d.last_seen_iso),
      entity_cluster: {
        cluster_id: ec.cluster_id == null ? null : String(ec.cluster_id),
        confidence: toNumber(ec.confidence),
        connected_wallets: Array.isArray(ec.connected_wallets) ? ec.connected_wallets.map(String) : [],
        signals_used: Array.isArray(ec.signals_used) ? ec.signals_used.map(String) : [],
      },
      behavioral_profile: {
        type: String(bp.type ?? "Individual Whale"),
        confidence: toNumber(bp.confidence),
        reasoning: Array.isArray(bp.reasoning) ? bp.reasoning.map(String) : [],
      },
    };
  }
  if (toolName === "compare_whales") {
    const wallets = Array.isArray(d.wallets)
      ? d.wallets.map((w) => (w != null && typeof w === "object" ? ensureObject(w) : {}))
      : [];
    return {
      wallets,
      ranking: Array.isArray(d.ranking) ? d.ranking.map((x) => String(x)) : [],
      best_for_copy_trading: d.best_for_copy_trading == null ? null : String(d.best_for_copy_trading),
      comparison_summary: String(d.comparison_summary ?? ""),
    };
  }
  if (toolName === "whale_risk_snapshot") {
    return {
      address: String(d.address ?? ""),
      ...(d.verdict != null && { verdict: String(d.verdict) }),
      ...(typeof d.confidence === "number" && !Number.isNaN(d.confidence) && { confidence: d.confidence }),
      risk_level: String(d.risk_level ?? "MEDIUM"),
      copy_trade_signal: String(d.copy_trade_signal ?? "NEUTRAL"),
      one_line_rationale: String(d.one_line_rationale ?? ""),
      agent_summary: String(d.agent_summary ?? ""),
    };
  }
  return d;
}

export async function runWhaleIntelReport(addr, limit = 50) {
  const [txs, internalTxs, analyze, balance] = await Promise.all([
    fetchTransactions(addr, limit),
    fetchInternalTransactions(addr),
    getApiUrl() ? fetchWhaleMindAnalyze(addr) : null,
    getApiUrl() ? fetchWhaleMindBalance(addr) : null,
  ]);
  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);

  const funding = analyzeFundingSources(txs, internalTxs, addr);
  const coordination = detectCoordination(txs, internalTxs, addr);
  const entityCluster = buildEntityCluster(addr, funding, coordination);
  const behavioralProfile = classifyBehavior(txs, funding, coordination, addr);

  const profileType = behavioralProfile.type || "Individual Whale";
  const summary =
    `Whale ${addr.slice(0, 10)}…: ${profileType}. ${v || "on-chain"}. ${i.copy_trade_signal}. ` +
    (analyze?.summary ? analyze.summary.slice(0, 80) + "…" : `${m.total_txs} txs, ${m.unique_counterparties} counterparties; cluster confidence ${entityCluster.confidence}.`);

  const out = {
    address: String(addr ?? ""),
    risk_level: String(i.risk_level ?? "MEDIUM"),
    copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
    total_txs: toNumber(m.total_txs),
    total_in_eth: toNumber(m.total_in_eth),
    total_out_eth: toNumber(m.total_out_eth),
    unique_counterparties: toNumber(m.unique_counterparties),
    agent_summary: String(summary ?? ""),
    balance_wei: toStringOrNull(balance),
    first_seen_iso: toStringOrNull(m.first_seen_iso),
    last_seen_iso: toStringOrNull(m.last_seen_iso),
    entity_cluster: {
      cluster_id: entityCluster.cluster_id,
      confidence: toNumber(entityCluster.confidence),
      connected_wallets: Array.isArray(entityCluster.connected_wallets) ? entityCluster.connected_wallets : [],
      signals_used: Array.isArray(entityCluster.signals_used) ? entityCluster.signals_used : [],
    },
    behavioral_profile: {
      type: String(behavioralProfile.type ?? "Individual Whale"),
      confidence: toNumber(behavioralProfile.confidence),
      reasoning: Array.isArray(behavioralProfile.reasoning) ? behavioralProfile.reasoning : [],
    },
  };
  if (v != null) out.verdict = String(v);
  if (typeof c === "number" && !Number.isNaN(c)) out.confidence = c;
  return ensureObject(out);
}

export async function runCompareWhales(addrs) {
  const results = await Promise.all(
    addrs.map(async (a) => {
      const txs = await fetchTransactions(a, 50);
      const m = analyzeTransactions(txs, a);
      const an = getApiUrl() ? await fetchWhaleMindAnalyze(a) : null;
      const v = an?.verdict;
      const c = an?.confidence;
      const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
      return {
        address: String(a ?? ""),
        ...(v != null && { verdict: String(v) }),
        ...(typeof c === "number" && !Number.isNaN(c) && { confidence: c }),
        smart_money_score: toNumber(i.smart_money_score),
        copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
        total_txs: toNumber(m.total_txs),
      };
    })
  );
  const by = [...results].sort((a, b) => b.smart_money_score - a.smart_money_score);
  const best = by[0]?.copy_trade_signal === "STRONG_BUY" || by[0]?.copy_trade_signal === "BUY" ? by[0].address : null;
  const cmp = best
    ? `Best for copy-trading: ${best.slice(0, 10)}… (score ${by[0]?.smart_money_score}).`
    : `Ranked: ${by.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;
  return ensureObject({
    wallets: results,
    ranking: by.map((w) => String(w.address)),
    best_for_copy_trading: best != null ? String(best) : null,
    comparison_summary: String(cmp),
  });
}

export async function runWhaleRiskSnapshot(addr) {
  const [txs, analyze] = await Promise.all([
    fetchTransactions(addr, 30),
    getApiUrl() ? fetchWhaleMindAnalyze(addr) : null,
  ]);
  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
  const ln = v ? `${i.copy_trade_signal}: ${v}, confidence ${Math.round((c || 0) * 100)}%.` : `${i.copy_trade_signal}: risk ${i.risk_level}, on-chain metrics.`;
  const out = {
    address: String(addr ?? ""),
    risk_level: String(i.risk_level ?? "MEDIUM"),
    copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
    one_line_rationale: String(ln ?? ""),
    agent_summary: String(`${i.copy_trade_signal}: ${addr.slice(0, 10)}… — ${ln}`),
  };
  if (v != null) out.verdict = String(v);
  if (typeof c === "number" && !Number.isNaN(c)) out.confidence = c;
  return ensureObject(out);
}
