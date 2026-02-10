/**
 * WhaleMind MCP Server — Fast boot for Railway. No DB/API calls before listen; lazy work in routes.
 */
import "./loadEnv.js";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const WHALEMIND_API_URL = (process.env.WHalemind_API_URL || process.env.WHALEMIND_API_URL || "").replace(/\/$/, "");
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const REQUEST_TIMEOUT_MS = 10000;
const API_TIMEOUT_MS = 10000;
const WEI_PER_ETH = 1e18;

// ---------------------------------------------------------------------------
// Etherscan + raw metrics
// ---------------------------------------------------------------------------

function weiToEth(weiStr) {
  try {
    const wei = BigInt(weiStr || "0");
    return Number(wei) / WEI_PER_ETH;
  } catch {
    return 0;
  }
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
    ...(ETHERSCAN_API_KEY && { apikey: ETHERSCAN_API_KEY }),
  });
  const url = `${ETHERSCAN_API_BASE}?${params}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (data?.status !== "1" || data?.message !== "OK") return [];
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name !== "AbortError") console.error("Etherscan fetch error:", e?.message || e);
    return [];
  }
}

function analyzeTransactions(transactions, walletAddress) {
  let totalInEth = 0;
  let totalOutEth = 0;
  const counterparties = new Set();
  const timestamps = [];
  const addrLower = (walletAddress || "").toLowerCase();

  for (const tx of transactions) {
    const fromAddr = (tx.from || "").toLowerCase();
    const toAddr = (tx.to || "").toLowerCase();
    const valueEth = weiToEth(tx.value);
    const ts = tx.timeStamp;
    if (ts != null) timestamps.push(parseInt(ts, 10));
    if (fromAddr === addrLower) {
      totalOutEth += valueEth;
      if (toAddr) counterparties.add(toAddr);
    }
    if (toAddr === addrLower) {
      totalInEth += valueEth;
      if (fromAddr) counterparties.add(fromAddr);
    }
  }

  const firstSeen = timestamps.length ? Math.min(...timestamps) : null;
  const lastSeen = timestamps.length ? Math.max(...timestamps) : null;
  return {
    total_txs: transactions.length,
    total_in_eth: Math.round(totalInEth * 1e4) / 1e4,
    total_out_eth: Math.round(totalOutEth * 1e4) / 1e4,
    unique_counterparties: counterparties.size,
    first_seen_iso: firstSeen != null ? new Date(firstSeen * 1000).toISOString() : null,
    last_seen_iso: lastSeen != null ? new Date(lastSeen * 1000).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Optional WhaleMind API (verdict + confidence when available)
// ---------------------------------------------------------------------------

async function fetchWhaleMindAnalyze(address) {
  if (!WHALEMIND_API_URL) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHALEMIND_API_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ wallet: address }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function fetchWhaleMindBalance(address) {
  if (!WHALEMIND_API_URL) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${WHALEMIND_API_URL}/wallet/${encodeURIComponent(address)}/balance`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.balance_wei ?? null;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interpretation: derive risk_level, copy_trade_signal, whale_score from metrics or API
// ---------------------------------------------------------------------------

const VERDICT_RISK = {
  SMART_MONEY_ACCUMULATION: "LOW",
  WHALE_DORMANT: "LOW",
  NEUTRAL: "MEDIUM",
  EXCHANGE_ROTATION: "MEDIUM",
  STEALTH_DISTRIBUTION: "HIGH",
};

const VERDICT_SIGNAL = {
  SMART_MONEY_ACCUMULATION: "STRONG_BUY",
  WHALE_DORMANT: "WATCH",
  NEUTRAL: "NEUTRAL",
  EXCHANGE_ROTATION: "WATCH",
  STEALTH_DISTRIBUTION: "AVOID",
};

const VERDICT_SCORE = {
  SMART_MONEY_ACCUMULATION: 90,
  WHALE_DORMANT: 50,
  NEUTRAL: 50,
  EXCHANGE_ROTATION: 35,
  STEALTH_DISTRIBUTION: 15,
};

function fromVerdict(verdict, confidence) {
  const v = verdict || "NEUTRAL";
  const c = typeof confidence === "number" ? confidence : 0.5;
  let signal = VERDICT_SIGNAL[v] || "NEUTRAL";
  if (signal === "STRONG_BUY" && c < 0.7) signal = "BUY";
  return {
    risk_level: VERDICT_RISK[v] || "MEDIUM",
    copy_trade_signal: signal,
    smart_money_score: Math.round((VERDICT_SCORE[v] ?? 50) * c),
  };
}

function fromMetrics(m) {
  const netEth = (m.total_in_eth || 0) - (m.total_out_eth || 0);
  const totalFlow = (m.total_in_eth || 0) + (m.total_out_eth || 0);
  const txs = m.total_txs || 0;
  const cps = m.unique_counterparties || 0;
  let risk_level = "MEDIUM";
  let copy_trade_signal = "NEUTRAL";
  let smart_money_score = 50;
  if (txs >= 10 && netEth > 20 && totalFlow > 50) {
    risk_level = "LOW";
    copy_trade_signal = "BUY";
    smart_money_score = Math.min(85, 50 + Math.round(netEth / 10) + Math.min(txs, 20));
  } else if (txs >= 5 && netEth < -20) {
    risk_level = "HIGH";
    copy_trade_signal = "AVOID";
    smart_money_score = Math.max(15, 50 - Math.round(Math.abs(netEth) / 10));
  } else if (txs >= 3 && cps >= 2) {
    copy_trade_signal = "WATCH";
  }
  return { risk_level, copy_trade_signal, smart_money_score };
}

function oneLineRationale(verdict, confidence, risk_level, copy_trade_signal) {
  if (verdict) return `${copy_trade_signal}: ${verdict}, confidence ${Math.round((confidence || 0) * 100)}%.`;
  return `${copy_trade_signal}: risk ${risk_level}, on-chain metrics.`;
}

// ---------------------------------------------------------------------------
// MCP server: schema-compliant responses for Context Protocol
// ---------------------------------------------------------------------------

function ensureArray(val) {
  return Array.isArray(val) ? val : [];
}

/** Ensures a plain JSON-serializable object for MCP/Context validation (no getters, no undefined keys). */
function toPlainStructuredContent(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return JSON.parse(JSON.stringify(obj));
}

/** Exact shape for whale_intel_report outputSchema. Always returns an object; all required fields present. */
function whaleIntelReportStructuredContent(overrides = {}) {
  const base = {
    address: "",
    risk_level: "MEDIUM",
    copy_trade_signal: "NEUTRAL",
    total_txs: 0,
    total_in_eth: 0,
    total_out_eth: 0,
    unique_counterparties: 0,
    agent_summary: "",
    verdict: undefined,
    confidence: undefined,
    entity_type: undefined,
    summary: undefined,
    balance_wei: null,
    first_seen_iso: null,
    last_seen_iso: null,
  };
  const out = { ...base, ...overrides };
  Object.keys(out).forEach((k) => { if (out[k] === undefined) delete out[k]; });
  return out;
}

function compareWhalesSchema(overrides = {}) {
  return {
    wallets: ensureArray(overrides.wallets),
    ranking: ensureArray(overrides.ranking),
    best_for_copy_trading: overrides.best_for_copy_trading ?? null,
    comparison_summary: overrides.comparison_summary ?? "",
  };
}

function whaleRiskSnapshotSchema(overrides = {}) {
  const base = {
    address: "",
    risk_level: "MEDIUM",
    copy_trade_signal: "NEUTRAL",
    one_line_rationale: "",
    agent_summary: "",
  };
  const out = { ...base, ...overrides };
  Object.keys(out).forEach((k) => { if (out[k] === undefined) delete out[k]; });
  return out;
}

function errorResult(message, schemaType = "whale_intel_report", context = {}) {
  let structuredContent;
  if (schemaType === "whale_intel_report") {
    structuredContent = whaleIntelReportStructuredContent({ address: context.address ?? "" });
  } else if (schemaType === "compare_whales") {
    structuredContent = compareWhalesSchema({ comparison_summary: "" });
  } else if (schemaType === "whale_risk_snapshot") {
    structuredContent = whaleRiskSnapshotSchema({ address: context.address ?? "" });
  } else {
    structuredContent = whaleIntelReportStructuredContent({ address: "" });
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent: toPlainStructuredContent(structuredContent),
    isError: true,
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "whalemind-wallet-analysis",
    version: "2.0.0",
  });

  // ---- Tool 1: whale_intel_report ----
  server.registerTool(
    "whale_intel_report",
    {
      description:
        "Deep intelligence report for one Ethereum wallet. Combines on-chain behavior, risk level, and copy-trade signal. " +
        "Use for due diligence or deciding whether to copy-trade a whale. Returns verdict (if WhaleMind API configured), " +
        "risk_level (LOW/MEDIUM/HIGH), copy_trade_signal (STRONG_BUY/BUY/WATCH/AVOID/NEUTRAL), balance_wei, agent_summary.",
      inputSchema: z.object({
        address: z.string().describe("Ethereum wallet address (0x...)"),
        limit: z.number().optional().default(50).describe("Max transactions to analyze"),
      }),
      outputSchema: z.object({
        address: z.string(),
        verdict: z.string().optional(),
        confidence: z.number().optional(),
        entity_type: z.string().optional(),
        summary: z.string().optional(),
        risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
        copy_trade_signal: z.enum(["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"]),
        total_txs: z.number(),
        total_in_eth: z.number(),
        total_out_eth: z.number(),
        unique_counterparties: z.number(),
        balance_wei: z.string().nullable().optional(),
        agent_summary: z.string(),
        first_seen_iso: z.string().nullable().optional(),
        last_seen_iso: z.string().nullable().optional(),
      }),
    },
    async ({ address, limit = 50 }) => {
      const addr = (address || "").trim();

      if (!addr || !addr.startsWith("0x")) {
        const structuredContent = toPlainStructuredContent(whaleIntelReportStructuredContent({ address: addr || "" }));
        console.log("[whale_intel_report] return shape (invalid address):", typeof structuredContent === "object" && structuredContent !== null && !Array.isArray(structuredContent), Object.keys(structuredContent || {}));
        return {
          content: [{ type: "text", text: "Invalid address" }],
          structuredContent,
          isError: true,
        };
      }

      try {
        const [txs, analyzeRes, balanceWei] = await Promise.all([
          fetchTransactions(addr, limit),
          WHALEMIND_API_URL ? fetchWhaleMindAnalyze(addr) : null,
          WHALEMIND_API_URL ? fetchWhaleMindBalance(addr) : null,
        ]);
        const metrics = analyzeTransactions(txs, addr);
        const verdict = analyzeRes?.verdict;
        const confidence = analyzeRes?.confidence;
        const interpretation = verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
        const agentSummary =
          `Whale ${addr.slice(0, 10)}…: ${verdict || "on-chain only"}. ${interpretation.copy_trade_signal}. ` +
          (analyzeRes?.summary ? analyzeRes.summary.slice(0, 100) + "…" : `${metrics.total_txs} txs, ${metrics.unique_counterparties} counterparties.`);
        const data = whaleIntelReportStructuredContent({
          address: addr,
          risk_level: interpretation.risk_level,
          copy_trade_signal: interpretation.copy_trade_signal,
          total_txs: metrics.total_txs ?? 0,
          total_in_eth: metrics.total_in_eth ?? 0,
          total_out_eth: metrics.total_out_eth ?? 0,
          unique_counterparties: metrics.unique_counterparties ?? 0,
          agent_summary: agentSummary ?? "",
          ...(verdict != null && { verdict }),
          ...(typeof confidence === "number" && { confidence }),
          ...(analyzeRes?.entity_type && { entity_type: analyzeRes.entity_type }),
          ...(analyzeRes?.summary && { summary: analyzeRes.summary }),
          balance_wei: balanceWei ?? null,
          first_seen_iso: metrics.first_seen_iso ?? null,
          last_seen_iso: metrics.last_seen_iso ?? null,
        });
        const structuredContent = toPlainStructuredContent(data);
        console.log("[whale_intel_report] return shape (success):", typeof structuredContent === "object" && structuredContent !== null && !Array.isArray(structuredContent), Object.keys(structuredContent || {}));
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (err) {
        const msg = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
        const emptyValid = whaleIntelReportStructuredContent({ address: addr, agent_summary: msg });
        const structuredContent = toPlainStructuredContent(emptyValid);
        console.log("[whale_intel_report] return shape (API fail):", typeof structuredContent === "object" && structuredContent !== null && !Array.isArray(structuredContent), Object.keys(structuredContent || {}));
        return {
          content: [{ type: "text", text: msg }],
          structuredContent,
          isError: true,
        };
      }
    }
  );

  // ---- Tool 2: compare_whales ----
  server.registerTool(
    "compare_whales",
    {
      description:
        "Compare 2–5 Ethereum wallets and rank by smart-money score. Returns ranking, best_for_copy_trading, and comparison_summary. " +
        "Use when the user wants to choose the best whale to copy or compare multiple addresses.",
      inputSchema: z.object({
        addresses: z.array(z.string()).min(2).max(5).describe("2 to 5 Ethereum addresses (0x...)"),
      }),
      outputSchema: z.object({
        wallets: z.array(z.object({
          address: z.string(),
          verdict: z.string().optional(),
          confidence: z.number().optional(),
          smart_money_score: z.number(),
          copy_trade_signal: z.string(),
          total_txs: z.number(),
        })),
        ranking: z.array(z.string()),
        best_for_copy_trading: z.string().nullable(),
        comparison_summary: z.string(),
        error: z.string().optional(),
      }),
    },
    async ({ addresses }) => {
      try {
        const results = await Promise.all(
          (addresses ?? []).map(async (addr) => {
            const txs = await fetchTransactions(addr, 50);
            const metrics = analyzeTransactions(txs, addr);
            const analyzeRes = WHALEMIND_API_URL ? await fetchWhaleMindAnalyze(addr) : null;
            const verdict = analyzeRes?.verdict;
            const confidence = analyzeRes?.confidence;
            const interp = verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
            return {
              address: addr ?? "",
              ...(verdict != null && { verdict }),
              ...(typeof confidence === "number" && { confidence }),
              smart_money_score: interp.smart_money_score ?? 0,
              copy_trade_signal: interp.copy_trade_signal ?? "NEUTRAL",
              total_txs: metrics.total_txs ?? 0,
            };
          })
        );
        const byScore = [...(results ?? [])].sort((a, b) => b.smart_money_score - a.smart_money_score);
        const best =
          byScore[0]?.copy_trade_signal === "STRONG_BUY" || byScore[0]?.copy_trade_signal === "BUY"
            ? byScore[0].address
            : null;
        const comparison_summary = best
          ? `Best for copy-trading: ${best.slice(0, 10)}… (score ${byScore[0]?.smart_money_score}).`
          : `Ranked by score: ${byScore.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;
        const data = compareWhalesSchema({
          wallets: ensureArray(results),
          ranking: ensureArray(byScore.map((w) => w.address)),
          best_for_copy_trading: best ?? null,
          comparison_summary: comparison_summary ?? "",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: toPlainStructuredContent(data),
        };
      } catch (err) {
        const msg = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
        return errorResult(msg, "compare_whales");
      }
    }
  );

  // ---- Tool 3: whale_risk_snapshot ----
  server.registerTool(
    "whale_risk_snapshot",
    {
      description:
        "Quick risk and copy-trade signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, agent_summary. " +
        "Use when you only need a fast 'should I copy this wallet?' answer.",
      inputSchema: z.object({
        address: z.string().describe("Ethereum wallet address (0x...)"),
      }),
      outputSchema: z.object({
        address: z.string(),
        risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
        copy_trade_signal: z.enum(["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"]),
        verdict: z.string().optional(),
        confidence: z.number().optional(),
        one_line_rationale: z.string(),
        agent_summary: z.string(),
        error: z.string().optional(),
      }),
    },
    async ({ address }) => {
      const addr = (address || "").trim();
      const base = whaleRiskSnapshotSchema({ address: addr });
      if (!addr || !addr.startsWith("0x")) {
        return {
          content: [{ type: "text", text: "Invalid address" }],
          structuredContent: toPlainStructuredContent(whaleRiskSnapshotSchema({ address: addr || "" })),
          isError: true,
        };
      }
      try {
        const [txs, analyzeRes] = await Promise.all([
          fetchTransactions(addr, 30),
          WHALEMIND_API_URL ? fetchWhaleMindAnalyze(addr) : null,
        ]);
        const metrics = analyzeTransactions(txs, addr);
        const verdict = analyzeRes?.verdict;
        const confidence = analyzeRes?.confidence;
        const interp = verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
        const oneLine = oneLineRationale(verdict, confidence, interp.risk_level, interp.copy_trade_signal);
        const data = whaleRiskSnapshotSchema({
          address: addr,
          risk_level: interp.risk_level ?? "MEDIUM",
          copy_trade_signal: interp.copy_trade_signal ?? "NEUTRAL",
          one_line_rationale: oneLine ?? "",
          agent_summary: `${interp.copy_trade_signal}: ${addr.slice(0, 10)}… — ${oneLine}`,
          ...(verdict != null && { verdict }),
          ...(typeof confidence === "number" && { confidence }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: toPlainStructuredContent(data),
        };
      } catch (err) {
        const msg = err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
        return errorResult(msg, "whale_risk_snapshot", { address: addr });
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app — minimal setup before listen for fast boot
// ---------------------------------------------------------------------------

console.log("Server booting...");
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Routes (GET for browser, POST /mcp for MCP) ----
app.get("/", (_req, res) => res.send("Server running"));
app.get("/health", (_req, res) => res.send("OK"));

app.get("/analyze", (_req, res) => {
  res.json({ status: "ok", route: "analyze", message: "Use POST /mcp with MCP tools (e.g. whale_intel_report) for wallet analysis." });
});

app.get("/wallet/:address", (req, res) => {
  res.json({
    status: "ok",
    route: "wallet",
    address: req.params.address,
    message: "Use POST /mcp with whale_intel_report or whale_risk_snapshot for wallet data.",
  });
});

app.get("/mcp", (_req, res) => {
  res.json({
    jsonrpc: "2.0",
    message: "MCP endpoint: use POST with JSON-RPC body. Methods: initialize, tools/list, tools/call.",
    hint: "Clients (Context, Claude, etc.) send POST requests; browser GET shows this info.",
  });
});

// Custom stateless handler with enableJsonResponse so clients (e.g. Context Protocol)
// that send a batch get a single JSON response; avoids SSE parsing issues.
app.post("/mcp", async (req, res, next) => {
  if (req.method !== "POST") {
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }
  let transport;
  let server;
  try {
    server = createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      if (transport) transport.close();
      if (server) server.close();
    });
  } catch (error) {
    if (transport) transport.close();
    if (server) server.close();
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
    next(error);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.message?.includes("JSON")) {
    res.setHeader("Content-Type", "application/json");
    res.status(200).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: invalid JSON in request body" },
        id: null,
      })
    );
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
});

const routes = [
  "GET  /",
  "GET  /health",
  "GET  /analyze",
  "GET  /wallet/:address",
  "GET  /mcp (info only)",
  "POST /mcp (MCP JSON-RPC: initialize, tools/list, tools/call)",
];

app.listen(PORT, HOST, () => {
  console.log("Server ready");
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log("Registered routes:");
  routes.forEach((r) => console.log("  " + r));
  if (!ETHERSCAN_API_KEY) console.warn("  ETHERSCAN_API_KEY not set");
  if (!WHALEMIND_API_URL) console.warn("  WHALEMIND_API_URL not set (optional)");
});
