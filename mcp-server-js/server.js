/**
 * WhaleMind MCP Server — MCP spec + Context Protocol compliant
 * Uses @modelcontextprotocol/sdk: Server, StreamableHTTPServerTransport
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";

const PORT = Number(process.env.PORT) || 3000;

// Production safety: never run with auth disabled in production
if (process.env.SKIP_CONTEXT_AUTH === "true" && process.env.NODE_ENV === "production") {
  console.error("[MCP] FATAL: SKIP_CONTEXT_AUTH must not be set in production!");
  process.exit(1);
}
const WHALEMIND_API_URL = (
  process.env.WHalemind_API_URL ||
  process.env.WHALEMIND_API_URL ||
  ""
).replace(/\/$/, "");
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const REQUEST_TIMEOUT_MS = 10000;
const API_TIMEOUT_MS = 10000;
const WEI_PER_ETH = 1e18;

const TOOLS = [
  {
    name: "whale_intel_report",
    description:
      "Deep intelligence report for one Ethereum wallet. Combines on-chain behavior, risk level, and copy-trade signal. " +
      "Use for due diligence or deciding whether to copy-trade a whale. Returns verdict (if WhaleMind API configured), " +
      "risk_level (LOW/MEDIUM/HIGH), copy_trade_signal (STRONG_BUY/BUY/WATCH/AVOID/NEUTRAL), balance_wei, agent_summary.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Ethereum wallet address (0x...)" },
        limit: { type: "number", description: "Max transactions to analyze", default: 50 },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      description: "Whale intelligence report — structured for AI parsing and payment verification",
      properties: {
        address: { type: "string", description: "Ethereum wallet address analyzed" },
        verdict: { type: "string", description: "WhaleMind verdict label (if API configured)" },
        confidence: { type: "number", description: "Confidence score 0–1" },
        entity_type: { type: "string", description: "Wallet classification (e.g. smart money, exchange)" },
        summary: { type: "string", description: "Extended analysis summary" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "Risk tier" },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"], description: "Copy-trade recommendation" },
        total_txs: { type: "number", description: "Total transactions analyzed" },
        total_in_eth: { type: "number", description: "Total ETH received" },
        total_out_eth: { type: "number", description: "Total ETH sent" },
        unique_counterparties: { type: "number", description: "Unique counterparty count" },
        balance_wei: { type: ["string", "null"], description: "Current balance in wei (string for precision)" },
        agent_summary: { type: "string", description: "One-line agent summary" },
        first_seen_iso: { type: ["string", "null"], description: "First activity timestamp ISO 8601" },
        last_seen_iso: { type: ["string", "null"], description: "Most recent activity timestamp ISO 8601" },
      },
      required: ["address", "risk_level", "copy_trade_signal", "total_txs", "total_in_eth", "total_out_eth", "unique_counterparties", "agent_summary"],
    },
  },
  {
    name: "compare_whales",
    description:
      "Compare 2–5 Ethereum wallets and rank by smart-money score. Returns ranking, best_for_copy_trading, and comparison_summary. " +
      "Use when the user wants to choose the best whale to copy or compare multiple addresses.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, description: "2 to 5 Ethereum addresses (0x...)" },
      },
      required: ["addresses"],
    },
    outputSchema: {
      type: "object",
      description: "Whale comparison — ranked by smart-money score for AI parsing",
      properties: {
        wallets: {
          type: "array",
          description: "Wallets sorted by smart_money_score descending",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "Ethereum wallet address" },
              verdict: { type: "string", description: "WhaleMind verdict if available" },
              confidence: { type: "number", description: "Confidence score 0–1" },
              smart_money_score: { type: "number", description: "0–100 score" },
              copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"], description: "Copy-trade recommendation" },
              total_txs: { type: "number", description: "Transaction count" },
            },
            required: ["address", "smart_money_score", "copy_trade_signal", "total_txs"],
          },
        },
        ranking: { type: "array", items: { type: "string" }, description: "Addresses in rank order" },
        best_for_copy_trading: { type: ["string", "null"], description: "Top BUY/STRONG_BUY address or null" },
        comparison_summary: { type: "string", description: "Human-readable comparison" },
      },
      required: ["wallets", "ranking", "best_for_copy_trading", "comparison_summary"],
    },
  },
  {
    name: "whale_risk_snapshot",
    description:
      "Quick risk and copy-trade signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, agent_summary. " +
      "Use when you only need a fast 'should I copy this wallet?' answer.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Ethereum wallet address (0x...)" } },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      description: "Quick risk snapshot — lightweight for fast copy-trade decisions",
      properties: {
        address: { type: "string", description: "Ethereum wallet address" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "Risk tier" },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"], description: "Copy-trade recommendation" },
        verdict: { type: "string", description: "WhaleMind verdict if available" },
        confidence: { type: "number", description: "Confidence score 0–1" },
        one_line_rationale: { type: "string", description: "Single-line rationale" },
        agent_summary: { type: "string", description: "Agent summary" },
      },
      required: ["address", "risk_level", "copy_trade_signal", "one_line_rationale", "agent_summary"],
    },
  },
];

const mcpServer = new Server(
  { name: "whalemind-wallet-analysis", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const toPlain = (o) => (o === null || typeof o !== "object" || Array.isArray(o) ? o : JSON.parse(JSON.stringify(o)));
const ensureObject = (o) => (o != null && typeof o === "object" && !Array.isArray(o) ? toPlain(o) : {});

/** Schema-defined keys per tool — ensures structuredContent matches outputSchema for Context payment verification & dispute resolution */
const SCHEMA_KEYS = {
  whale_intel_report: ["address", "verdict", "confidence", "entity_type", "summary", "risk_level", "copy_trade_signal", "total_txs", "total_in_eth", "total_out_eth", "unique_counterparties", "balance_wei", "agent_summary", "first_seen_iso", "last_seen_iso"],
  compare_whales: ["wallets", "ranking", "best_for_copy_trading", "comparison_summary"],
  whale_risk_snapshot: ["address", "risk_level", "copy_trade_signal", "verdict", "confidence", "one_line_rationale", "agent_summary"],
};
const WALLET_ITEM_KEYS = ["address", "verdict", "confidence", "smart_money_score", "copy_trade_signal", "total_txs"];

function filterToSchema(data, toolName) {
  if (!data || typeof data !== "object") return data;
  const keys = SCHEMA_KEYS[toolName];
  if (!keys) return toPlain(data);
  const out = {};
  for (const k of keys) if (k in data) out[k] = data[k];
  if (toolName === "compare_whales" && Array.isArray(out.wallets)) {
    out.wallets = out.wallets.map((w) => {
      const wout = {};
      for (const k of WALLET_ITEM_KEYS) if (k in w) wout[k] = w[k];
      return wout;
    });
  }
  return out;
}

const whaleIntelShape = (o = {}) => {
  const base = {
    address: "", risk_level: "MEDIUM", copy_trade_signal: "NEUTRAL", total_txs: 0, total_in_eth: 0, total_out_eth: 0,
    unique_counterparties: 0, agent_summary: "", balance_wei: null, first_seen_iso: null, last_seen_iso: null,
  };
  const merged = { ...base, ...o };
  merged.balance_wei = merged.balance_wei != null ? String(merged.balance_wei) : null;
  merged.first_seen_iso = merged.first_seen_iso != null ? String(merged.first_seen_iso) : null;
  merged.last_seen_iso = merged.last_seen_iso != null ? String(merged.last_seen_iso) : null;
  return merged;
};
const compareShape = (o = {}) => ({
  wallets: [], ranking: [], best_for_copy_trading: null, comparison_summary: "", ...o,
});
const riskShape = (o = {}) => ({
  address: "", risk_level: "MEDIUM", copy_trade_signal: "NEUTRAL", one_line_rationale: "", agent_summary: "", ...o,
});
const successResult = (d, toolName) => {
  const filtered = filterToSchema(d, toolName);
  return {
    content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
    structuredContent: ensureObject(filtered),
  };
};
const errorResult = (schema, msg, ctx) => {
  const sc = schema === "whale_intel_report" ? whaleIntelShape({ address: ctx?.address ?? "", agent_summary: msg })
    : schema === "compare_whales" ? compareShape({ comparison_summary: msg })
    : riskShape({ address: ctx?.address ?? "", one_line_rationale: msg, agent_summary: msg });
  return { content: [{ type: "text", text: msg }], structuredContent: ensureObject(sc), isError: true };
};

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "whale_intel_report": {
        const addr = (args?.address ?? "").trim();
        const limit = typeof args?.limit === "number" ? args.limit : 50;
        if (!addr || !addr.startsWith("0x")) return errorResult("whale_intel_report", "Invalid address", { address: addr || "" });
        return successResult(await runWhaleIntelReport(addr, limit), "whale_intel_report");
      }
      case "compare_whales": {
        const addrs = Array.isArray(args?.addresses) ? args.addresses : [];
        if (addrs.length < 2 || addrs.length > 5) return errorResult("compare_whales", "Need 2 to 5 addresses", {});
        return successResult(await runCompareWhales(addrs), "compare_whales");
      }
      case "whale_risk_snapshot": {
        const addr = (args?.address ?? "").trim();
        if (!addr || !addr.startsWith("0x")) return errorResult("whale_risk_snapshot", "Invalid address", { address: addr || "" });
        return successResult(await runWhaleRiskSnapshot(addr), "whale_risk_snapshot");
      }
      default:
        return errorResult("whale_intel_report", `Unknown tool: ${name}`, {});
    }
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Request timeout" : (e?.message || String(e));
    return errorResult(
      name === "compare_whales" ? "compare_whales" : name === "whale_risk_snapshot" ? "whale_risk_snapshot" : "whale_intel_report",
      msg,
      { address: args?.address ?? "" }
    );
  }
});

function weiToEth(w) {
  try { return Number(BigInt(w || "0")) / WEI_PER_ETH; } catch { return 0; }
}

async function fetchTransactions(address, limit = 20) {
  const params = new URLSearchParams({
    chainid: "1", module: "account", action: "txlist", address,
    startblock: "0", endblock: "99999999", page: "1", offset: String(Math.min(limit, 10000)),
    sort: "desc", ...(ETHERSCAN_API_KEY && { apikey: ETHERSCAN_API_KEY }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_API_BASE}?${params}`, { signal: ctrl.signal });
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

function analyzeTransactions(txs, addr) {
  let inEth = 0, outEth = 0;
  const cp = new Set();
  const ts = [];
  const low = (addr || "").toLowerCase();
  for (const tx of txs) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    const v = weiToEth(tx.value);
    if (tx.timeStamp != null) ts.push(parseInt(tx.timeStamp, 10));
    if (from === low) { outEth += v; if (to) cp.add(to); }
    if (to === low) { inEth += v; if (from) cp.add(from); }
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
  if (!WHALEMIND_API_URL) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHALEMIND_API_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ wallet: addr }),
      signal: c.signal,
    });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch { clearTimeout(t); return null; }
}

async function fetchWhaleMindBalance(addr) {
  if (!WHALEMIND_API_URL) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHALEMIND_API_URL}/wallet/${encodeURIComponent(addr)}/balance`, {
      headers: { Accept: "application/json" }, signal: c.signal,
    });
    clearTimeout(t);
    const data = res.ok ? await res.json() : null;
    return data?.balance_wei ?? null;
  } catch { clearTimeout(t); return null; }
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
  let risk = "MEDIUM", signal = "NEUTRAL", score = 50;
  if (txs >= 10 && net > 20 && flow > 50) {
    risk = "LOW"; signal = "BUY";
    score = Math.min(85, 50 + Math.round(net / 10) + Math.min(txs, 20));
  } else if (txs >= 5 && net < -20) {
    risk = "HIGH"; signal = "AVOID";
    score = Math.max(15, 50 - Math.round(Math.abs(net) / 10));
  } else if (txs >= 3 && cps >= 2) signal = "WATCH";
  return { risk_level: risk, copy_trade_signal: signal, smart_money_score: score };
}

function oneLine(verdict, conf, risk, sig) {
  return verdict ? `${sig}: ${verdict}, confidence ${Math.round((conf || 0) * 100)}%.`
    : `${sig}: risk ${risk}, on-chain metrics.`;
}

async function runWhaleIntelReport(addr, limit) {
  const [txs, analyze, balance] = await Promise.all([
    fetchTransactions(addr, limit),
    WHALEMIND_API_URL ? fetchWhaleMindAnalyze(addr) : null,
    WHALEMIND_API_URL ? fetchWhaleMindBalance(addr) : null,
  ]);
  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
  const summary = `Whale ${addr.slice(0, 10)}…: ${v || "on-chain only"}. ${i.copy_trade_signal}. ` +
    (analyze?.summary ? analyze.summary.slice(0, 100) + "…" : `${m.total_txs} txs, ${m.unique_counterparties} counterparties.`);
  return whaleIntelShape({
    address: addr, risk_level: i.risk_level, copy_trade_signal: i.copy_trade_signal,
    total_txs: m.total_txs ?? 0, total_in_eth: m.total_in_eth ?? 0, total_out_eth: m.total_out_eth ?? 0,
    unique_counterparties: m.unique_counterparties ?? 0, agent_summary: summary ?? "",
    ...(v != null && { verdict: v }), ...(typeof c === "number" && { confidence: c }),
    ...(analyze?.entity_type && { entity_type: analyze.entity_type }),
    ...(analyze?.summary && { summary: analyze.summary }),
    balance_wei: balance ?? null, first_seen_iso: m.first_seen_iso ?? null, last_seen_iso: m.last_seen_iso ?? null,
  });
}

async function runCompareWhales(addrs) {
  const results = await Promise.all(addrs.map(async (a) => {
    const txs = await fetchTransactions(a, 50);
    const m = analyzeTransactions(txs, a);
    const an = WHALEMIND_API_URL ? await fetchWhaleMindAnalyze(a) : null;
    const v = an?.verdict;
    const c = an?.confidence;
    const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
    return {
      address: a ?? "",
      ...(v != null && { verdict: v }), ...(typeof c === "number" && { confidence: c }),
      smart_money_score: i.smart_money_score ?? 0, copy_trade_signal: i.copy_trade_signal ?? "NEUTRAL",
      total_txs: m.total_txs ?? 0,
    };
  }));
  const by = [...results].sort((a, b) => b.smart_money_score - a.smart_money_score);
  const best = by[0]?.copy_trade_signal === "STRONG_BUY" || by[0]?.copy_trade_signal === "BUY" ? by[0].address : null;
  const cmp = best ? `Best for copy-trading: ${best.slice(0, 10)}… (score ${by[0]?.smart_money_score}).`
    : `Ranked: ${by.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;
  return compareShape({ wallets: results, ranking: by.map((w) => w.address), best_for_copy_trading: best ?? null, comparison_summary: cmp });
}

async function runWhaleRiskSnapshot(addr) {
  const [txs, analyze] = await Promise.all([
    fetchTransactions(addr, 30),
    WHALEMIND_API_URL ? fetchWhaleMindAnalyze(addr) : null,
  ]);
  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
  const ln = oneLine(v, c, i.risk_level, i.copy_trade_signal);
  return riskShape({
    address: addr, risk_level: i.risk_level ?? "MEDIUM", copy_trade_signal: i.copy_trade_signal ?? "NEUTRAL",
    one_line_rationale: ln ?? "", agent_summary: `${i.copy_trade_signal}: ${addr.slice(0, 10)}… — ${ln}`,
    ...(v != null && { verdict: v }), ...(typeof c === "number" && { confidence: c }),
  });
}

const isInitRequest = (b) => (Array.isArray(b) ? b.some(isInitializeRequest) : isInitializeRequest(b));

const transports = {};
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.redirect(301, "/health"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// Context auth: initialize + tools/list → no JWT; tools/call → JWT required
const SKIP_CONTEXT_AUTH = process.env.SKIP_CONTEXT_AUTH === "true";
if (!SKIP_CONTEXT_AUTH) {
  app.use(
    "/mcp",
    createContextMiddleware({
      audience: process.env.MCP_ENDPOINT_URL || undefined,
    })
  );
} else {
  console.warn("[MCP] SKIP_CONTEXT_AUTH=true — JWT verification disabled (dev only!)");
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const body = req.body ?? {};
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log("[MCP] Session initialized:", id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log("[MCP] Session closed:", transport.sessionId);
      }
    };
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize request first." },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[MCP] handleRequest error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => res.set("Allow", "POST").status(405).end());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.message?.includes("JSON")) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: invalid JSON" },
      id: null,
    });
    return;
  }
  console.error("[MCP] Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("MCP Server running on port", PORT);
});
