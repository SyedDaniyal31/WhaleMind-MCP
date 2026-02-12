/**
 * MCP Server Reference — Bridge between AI and the real world
 *
 * Flow: 1) Client connects (initialize) → 2) Tool discovery (tools/list) → 3) Tool execution (tools/call)
 * Auth: initialize/tools/list = OPEN; tools/call = PROTECTED (JWT required via Context)
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

// ---------------------------------------------------------------------------
// 1) TOOLS — AI discovers these via tools/list
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_gas_price",
    description: "Get current Ethereum gas price in gwei. Use for gas cost estimation.",
    inputSchema: {
      type: "object",
      properties: { chainId: { type: "number", description: "EVM chain ID", default: 1 } },
    },
    outputSchema: {
      type: "object",
      properties: {
        gasPriceGwei: { type: "number", description: "Gas price in gwei" },
        chainId: { type: "number" },
        unit: { type: "string" },
      },
      required: ["gasPriceGwei", "chainId", "unit"],
    },
  },
  {
    name: "analyze_wallet",
    description: "Deep behavioral analysis of an Ethereum wallet. Returns flow trends, risk score, and copy-trade signal.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Ethereum address (0x...)" },
        limit: { type: "number", description: "Max transactions to analyze", default: 50 },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"] },
        total_txs: { type: "number" },
        total_in_eth: { type: "number" },
        total_out_eth: { type: "number" },
        unique_counterparties: { type: "number" },
        agent_summary: { type: "string" },
      },
      required: ["address", "risk_level", "copy_trade_signal", "total_txs", "agent_summary"],
    },
  },
  {
    name: "whale_alerts",
    description: "Detect large transactions and unusual movements. Returns whale movements with severity.",
    inputSchema: {
      type: "object",
      properties: {
        minEth: { type: "number", description: "Minimum ETH to detect", default: 10 },
        limit: { type: "number", description: "Max alerts", default: 10 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        alerts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              valueEth: { type: "number" },
              severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
              summary: { type: "string" },
            },
            required: ["from", "to", "valueEth", "severity", "summary"],
          },
        },
        count: { type: "number" },
      },
      required: ["alerts", "count"],
    },
  },
];

// ---------------------------------------------------------------------------
// 2) MCP Server
// ---------------------------------------------------------------------------

const mcpServer = new Server(
  { name: "mcp-server-reference", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_gas_price": {
      const chainId = args?.chainId ?? 1;
      const gasPriceGwei = chainId === 1 ? 25 : 50; // Mock
      return {
        content: [{ type: "text", text: `Gas price: ${gasPriceGwei} gwei` }],
        structuredContent: { gasPriceGwei, chainId, unit: "gwei" },
      };
    }
    case "analyze_wallet": {
      const addr = (args?.address ?? "").trim();
      const limit = args?.limit ?? 50;
      if (!addr || !addr.startsWith("0x")) {
        return {
          content: [{ type: "text", text: "Invalid address" }],
          structuredContent: {
            address: addr || "",
            risk_level: "MEDIUM",
            copy_trade_signal: "NEUTRAL",
            total_txs: 0,
            total_in_eth: 0,
            total_out_eth: 0,
            unique_counterparties: 0,
            agent_summary: "Invalid address provided",
          },
          isError: true,
        };
      }
      const data = await runAnalyzeWallet(addr, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    }
    case "whale_alerts": {
      const minEth = args?.minEth ?? 10;
      const limit = args?.limit ?? 10;
      const data = await runWhaleAlerts(minEth, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        structuredContent: { error: `Unknown tool: ${name}` },
        isError: true,
      };
  }
});

// ---------------------------------------------------------------------------
// 3) Tool implementations (fetch data, process, return structured)
// ---------------------------------------------------------------------------

const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const WEI_PER_ETH = 1e18;

async function fetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await globalThis.fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

function weiToEth(w) {
  try {
    return Number(BigInt(w || "0")) / WEI_PER_ETH;
  } catch {
    return 0;
  }
}

async function runAnalyzeWallet(address, limit) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(Math.min(limit, 100)),
    sort: "desc",
    ...(ETHERSCAN_KEY && { apikey: ETHERSCAN_KEY }),
  });
  const data = await fetch(`${ETHERSCAN_API}?${params}`);
  const txs = data?.status === "1" && Array.isArray(data.result) ? data.result : [];

  let inEth = 0,
    outEth = 0;
  const cp = new Set();
  const low = address.toLowerCase();
  for (const tx of txs) {
    const v = weiToEth(tx.value);
    if (tx.from?.toLowerCase() === low) {
      outEth += v;
      if (tx.to) cp.add(tx.to);
    }
    if (tx.to?.toLowerCase() === low) {
      inEth += v;
      if (tx.from) cp.add(tx.from);
    }
  }

  const net = inEth - outEth;
  const flow = inEth + outEth;
  let risk = "MEDIUM",
    signal = "NEUTRAL";
  if (txs.length >= 10 && net > 20 && flow > 50) {
    risk = "LOW";
    signal = "BUY";
  } else if (txs.length >= 5 && net < -20) {
    risk = "HIGH";
    signal = "AVOID";
  } else if (txs.length >= 3 && cp.size >= 2) signal = "WATCH";

  const summary = `Wallet ${address.slice(0, 10)}…: ${risk} risk, ${signal}. ${txs.length} txs, ${cp.size} counterparties.`;

  return {
    address,
    risk_level: risk,
    copy_trade_signal: signal,
    total_txs: txs.length,
    total_in_eth: Math.round(inEth * 1e4) / 1e4,
    total_out_eth: Math.round(outEth * 1e4) / 1e4,
    unique_counterparties: cp.size,
    agent_summary: summary,
  };
}

async function runWhaleAlerts(minEth, limit) {
  const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: "100",
    sort: "desc",
    ...(ETHERSCAN_KEY && { apikey: ETHERSCAN_KEY }),
  });
  const data = await fetch(`${ETHERSCAN_API}?${params}`);
  const txs = data?.status === "1" && Array.isArray(data.result) ? data.result : [];

  const alerts = [];
  for (const tx of txs) {
    const v = weiToEth(tx.value);
    if (v >= minEth) {
      alerts.push({
        from: tx.from || "unknown",
        to: tx.to || "unknown",
        valueEth: Math.round(v * 100) / 100,
        severity: v >= 100 ? "HIGH" : v >= 50 ? "MEDIUM" : "LOW",
        summary: `${v.toFixed(2)} ETH from ${(tx.from || "").slice(0, 10)}… to ${(tx.to || "").slice(0, 10)}…`,
      });
      if (alerts.length >= limit) break;
    }
  }

  return { alerts, count: alerts.length };
}

// ---------------------------------------------------------------------------
// 4) Session handling
// ---------------------------------------------------------------------------

const isInitRequest = (b) =>
  Array.isArray(b) ? b.some(isInitializeRequest) : isInitializeRequest(b));

const transports = {};
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.redirect(301, "/health"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// Context auth: initialize + tools/list = OPEN; tools/call = PROTECTED (JWT)
const SKIP_CONTEXT_AUTH = process.env.SKIP_CONTEXT_AUTH === "true";
if (!SKIP_CONTEXT_AUTH) {
  app.use(
    "/mcp",
    createContextMiddleware({
      audience: process.env.MCP_ENDPOINT_URL || undefined,
    })
  );
} else {
  console.warn("[MCP] SKIP_CONTEXT_AUTH=true — JWT disabled (dev only!)");
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
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize first." },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[MCP] Error:", err);
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

// ---------------------------------------------------------------------------
// 5) Start
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("MCP Server running on port", PORT);
  console.log("  GET  /health — health check");
  console.log("  POST /mcp    — initialize → tools/list → tools/call");
});
