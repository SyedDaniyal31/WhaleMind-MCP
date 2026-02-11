/**
 * WhaleMind MCP Server — Context Protocol compliant (Blocknative example pattern).
 *
 * Architecture:
 * - Low-level Server from @modelcontextprotocol/sdk
 * - TOOLS array with plain JSON Schema (inputSchema, outputSchema)
 * - setRequestHandler(ListToolsRequestSchema, CallToolRequestSchema)
 * - Streamable HTTP transport
 * - createContextMiddleware for Context Protocol security
 *
 * See: https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema
 */
import "./loadEnv.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
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

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS — Plain JSON Schema (Blocknative pattern)
// ---------------------------------------------------------------------------

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
        address: {
          type: "string",
          description: "Ethereum wallet address (0x...)",
        },
        limit: {
          type: "number",
          description: "Max transactions to analyze",
          default: 50,
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        verdict: { type: "string" },
        confidence: { type: "number" },
        entity_type: { type: "string" },
        summary: { type: "string" },
        risk_level: {
          type: "string",
          enum: ["LOW", "MEDIUM", "HIGH"],
        },
        copy_trade_signal: {
          type: "string",
          enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"],
        },
        total_txs: { type: "number" },
        total_in_eth: { type: "number" },
        total_out_eth: { type: "number" },
        unique_counterparties: { type: "number" },
        balance_wei: { type: ["string", "null"] },
        agent_summary: { type: "string" },
        first_seen_iso: { type: ["string", "null"] },
        last_seen_iso: { type: ["string", "null"] },
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
      ],
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
        addresses: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
          description: "2 to 5 Ethereum addresses (0x...)",
        },
      },
      required: ["addresses"],
    },
    outputSchema: {
      type: "object",
      properties: {
        wallets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              verdict: { type: "string" },
              confidence: { type: "number" },
              smart_money_score: { type: "number" },
              copy_trade_signal: { type: "string" },
              total_txs: { type: "number" },
            },
            required: [
              "address",
              "smart_money_score",
              "copy_trade_signal",
              "total_txs",
            ],
          },
        },
        ranking: {
          type: "array",
          items: { type: "string" },
        },
        best_for_copy_trading: { type: ["string", "null"] },
        comparison_summary: { type: "string" },
      },
      required: [
        "wallets",
        "ranking",
        "best_for_copy_trading",
        "comparison_summary",
      ],
    },
  },
  {
    name: "whale_risk_snapshot",
    description:
      "Quick risk and copy-trade signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, agent_summary. " +
      "Use when you only need a fast 'should I copy this wallet?' answer.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Ethereum wallet address (0x...)",
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        risk_level: {
          type: "string",
          enum: ["LOW", "MEDIUM", "HIGH"],
        },
        copy_trade_signal: {
          type: "string",
          enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"],
        },
        verdict: { type: "string" },
        confidence: { type: "number" },
        one_line_rationale: { type: "string" },
        agent_summary: { type: "string" },
      },
      required: [
        "address",
        "risk_level",
        "copy_trade_signal",
        "one_line_rationale",
        "agent_summary",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP SERVER — Low-level Server + setRequestHandler (Blocknative)
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "whalemind-wallet-analysis", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "whale_intel_report": {
        const address = (args?.address ?? "").trim();
        const limit = typeof args?.limit === "number" ? args.limit : 50;
        if (!address || !address.startsWith("0x")) {
          return errorResult(
            "whale_intel_report",
            "Invalid address",
            { address: address || "" }
          );
        }
        const result = await runWhaleIntelReport(address, limit);
        return successResult(result);
      }
      case "compare_whales": {
        const addresses = Array.isArray(args?.addresses) ? args.addresses : [];
        if (addresses.length < 2 || addresses.length > 5) {
          return errorResult(
            "compare_whales",
            "Need 2 to 5 addresses",
            {}
          );
        }
        const result = await runCompareWhales(addresses);
        return successResult(result);
      }
      case "whale_risk_snapshot": {
        const address = (args?.address ?? "").trim();
        if (!address || !address.startsWith("0x")) {
          return errorResult(
            "whale_risk_snapshot",
            "Invalid address",
            { address: address || "" }
          );
        }
        const result = await runWhaleRiskSnapshot(address);
        return successResult(result);
      }
      default:
        return errorResult("whale_intel_report", `Unknown tool: ${name}`, {});
    }
  } catch (err) {
    const msg =
      err?.name === "AbortError" ? "Request timeout" : (err?.message || String(err));
    return errorResult(
      name === "compare_whales" ? "compare_whales" : name === "whale_risk_snapshot" ? "whale_risk_snapshot" : "whale_intel_report",
      msg,
      { address: args?.address ?? "" }
    );
  }
});

// ---------------------------------------------------------------------------
// RESPONSE HELPERS — Context Protocol: content + structuredContent
// ----------------------------------------------------------------------------

function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: toPlain(data),
  };
}

function errorResult(schemaType, message, context) {
  let structuredContent;
  if (schemaType === "whale_intel_report") {
    structuredContent = whaleIntelReportShape({
      address: context?.address ?? "",
      agent_summary: message,
    });
  } else if (schemaType === "compare_whales") {
    structuredContent = compareWhalesShape({ comparison_summary: message });
  } else if (schemaType === "whale_risk_snapshot") {
    structuredContent = whaleRiskSnapshotShape({
      address: context?.address ?? "",
      one_line_rationale: message,
      agent_summary: message,
    });
  } else {
    structuredContent = whaleIntelReportShape({ address: "", agent_summary: message });
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent: toPlain(structuredContent),
    isError: true,
  };
}

function toPlain(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function whaleIntelReportShape(overrides = {}) {
  const base = {
    address: "",
    risk_level: "MEDIUM",
    copy_trade_signal: "NEUTRAL",
    total_txs: 0,
    total_in_eth: 0,
    total_out_eth: 0,
    unique_counterparties: 0,
    agent_summary: "",
    balance_wei: null,
    first_seen_iso: null,
    last_seen_iso: null,
  };
  return { ...base, ...overrides };
}

function compareWhalesShape(overrides = {}) {
  const base = {
    wallets: [],
    ranking: [],
    best_for_copy_trading: null,
    comparison_summary: "",
  };
  return { ...base, ...overrides };
}

function whaleRiskSnapshotShape(overrides = {}) {
  const base = {
    address: "",
    risk_level: "MEDIUM",
    copy_trade_signal: "NEUTRAL",
    one_line_rationale: "",
    agent_summary: "",
  };
  return { ...base, ...overrides };
}

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
    if (e?.name !== "AbortError")
      console.error("Etherscan fetch error:", e?.message || e);
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
// WhaleMind API (optional)
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
    const res = await fetch(
      `${WHALEMIND_API_URL}/wallet/${encodeURIComponent(address)}/balance`,
      { headers: { Accept: "application/json" }, signal: controller.signal }
    );
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
// Interpretation logic
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
    smart_money_score = Math.min(
      85,
      50 + Math.round(netEth / 10) + Math.min(txs, 20)
    );
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
  if (verdict)
    return `${copy_trade_signal}: ${verdict}, confidence ${Math.round((confidence || 0) * 100)}%.`;
  return `${copy_trade_signal}: risk ${risk_level}, on-chain metrics.`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runWhaleIntelReport(address, limit) {
  const [txs, analyzeRes, balanceWei] = await Promise.all([
    fetchTransactions(address, limit),
    WHALEMIND_API_URL ? fetchWhaleMindAnalyze(address) : null,
    WHALEMIND_API_URL ? fetchWhaleMindBalance(address) : null,
  ]);
  const metrics = analyzeTransactions(txs, address);
  const verdict = analyzeRes?.verdict;
  const confidence = analyzeRes?.confidence;
  const interpretation =
    verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
  const agentSummary =
    `Whale ${address.slice(0, 10)}…: ${verdict || "on-chain only"}. ${interpretation.copy_trade_signal}. ` +
    (analyzeRes?.summary ? analyzeRes.summary.slice(0, 100) + "…" : `${metrics.total_txs} txs, ${metrics.unique_counterparties} counterparties.`);

  return whaleIntelReportShape({
    address,
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
}

async function runCompareWhales(addresses) {
  const results = await Promise.all(
    addresses.map(async (addr) => {
      const txs = await fetchTransactions(addr, 50);
      const metrics = analyzeTransactions(txs, addr);
      const analyzeRes = WHALEMIND_API_URL ? await fetchWhaleMindAnalyze(addr) : null;
      const verdict = analyzeRes?.verdict;
      const confidence = analyzeRes?.confidence;
      const interp =
        verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
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
  const byScore = [...results].sort(
    (a, b) => b.smart_money_score - a.smart_money_score
  );
  const best =
    byScore[0]?.copy_trade_signal === "STRONG_BUY" ||
    byScore[0]?.copy_trade_signal === "BUY"
      ? byScore[0].address
      : null;
  const comparison_summary = best
    ? `Best for copy-trading: ${best.slice(0, 10)}… (score ${byScore[0]?.smart_money_score}).`
    : `Ranked by score: ${byScore.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;

  return compareWhalesShape({
    wallets: results,
    ranking: byScore.map((w) => w.address),
    best_for_copy_trading: best ?? null,
    comparison_summary: comparison_summary ?? "",
  });
}

async function runWhaleRiskSnapshot(address) {
  const [txs, analyzeRes] = await Promise.all([
    fetchTransactions(address, 30),
    WHALEMIND_API_URL ? fetchWhaleMindAnalyze(address) : null,
  ]);
  const metrics = analyzeTransactions(txs, address);
  const verdict = analyzeRes?.verdict;
  const confidence = analyzeRes?.confidence;
  const interp =
    verdict != null ? fromVerdict(verdict, confidence) : fromMetrics(metrics);
  const oneLine = oneLineRationale(
    verdict,
    confidence,
    interp.risk_level,
    interp.copy_trade_signal
  );

  return whaleRiskSnapshotShape({
    address,
    risk_level: interp.risk_level ?? "MEDIUM",
    copy_trade_signal: interp.copy_trade_signal ?? "NEUTRAL",
    one_line_rationale: oneLine ?? "",
    agent_summary: `${interp.copy_trade_signal}: ${address.slice(0, 10)}… — ${oneLine}`,
    ...(verdict != null && { verdict }),
    ...(typeof confidence === "number" && { confidence }),
  });
}

// ---------------------------------------------------------------------------
// Express + Streamable HTTP (Blocknative pattern)
// ---------------------------------------------------------------------------

const transports = {};
const verifyContextAuth = createContextMiddleware();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("Server running"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "whalemind-mcp", version: "1.0.0" });
});

app.get("/analyze", (_req, res) => {
  res.json({
    status: "ok",
    route: "analyze",
    message: "Use POST /mcp with MCP tools (e.g. whale_intel_report) for wallet analysis.",
  });
});

app.get("/wallet/:address", (req, res) => {
  res.json({
    status: "ok",
    route: "wallet",
    address: req.params.address,
    message: "Use POST /mcp with whale_intel_report or whale_risk_snapshot for wallet data.",
  });
});

// MCP endpoint — session-based like Blocknative
app.post("/mcp", verifyContextAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Invalid session. Send initialize request first.",
      },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP handleRequest error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", verifyContextAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];

  if (transport) {
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP GET error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", verifyContextAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];

  if (transport) {
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP DELETE error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.message?.includes("JSON")) {
    res.type("text/plain").status(400).send("Parse error: invalid JSON in request body");
    return;
  }
  console.error("Unhandled error:", err);
  if (!res.headersSent) res.type("text/plain").status(500).send("Internal error");
});

console.log("Server booting...");
app.listen(PORT, HOST, () => {
  console.log("Server ready");
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log("Routes: GET /, GET /health, GET /analyze, GET /wallet/:address");
  console.log("MCP: POST /mcp (initialize, tools/list, tools/call), GET /mcp, DELETE /mcp");
  if (!ETHERSCAN_API_KEY) console.warn("ETHERSCAN_API_KEY not set");
  if (!WHALEMIND_API_URL) console.warn("WHALEMIND_API_URL not set (optional)");
});
