/**
 * MCP handler — SDK-based Server, StreamableHTTPServerTransport
 * Handles initialize, tools/list, tools/call with proper session lifecycle
 * One Server instance per session (SDK requires single transport per Server)
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_DEFINITIONS,
  coerceToOutputSchema,
  runWhaleIntelReport,
  runCompareWhales,
  runWhaleRiskSnapshot,
} from "./tools.js";

const transports = {};

function createMcpServer() {
  const server = new Server(
    { name: "whalemind-wallet-analysis", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, createToolHandler());
  return server;
}

function createToolHandler() {
  return async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "whale_intel_report": {
          const addr = (args?.address ?? "").trim();
          const limit = typeof args?.limit === "number" ? args.limit : 50;
          if (!addr || !addr.startsWith("0x")) return errorResult("whale_intel_report", "Invalid address", { address: addr || "" });
          return successResult(await runWhaleIntelReport(addr, limit), name);
        }
        case "compare_whales": {
          const addrs = Array.isArray(args?.addresses) ? args.addresses : [];
          if (addrs.length < 2 || addrs.length > 5) return errorResult("compare_whales", "Need 2 to 5 addresses", {});
          return successResult(await runCompareWhales(addrs), name);
        }
        case "whale_risk_snapshot": {
          const addr = (args?.address ?? "").trim();
          if (!addr || !addr.startsWith("0x")) return errorResult("whale_risk_snapshot", "Invalid address", { address: addr || "" });
          return successResult(await runWhaleRiskSnapshot(addr), name);
        }
        default:
          return errorResult("whale_intel_report", `Unknown tool: ${name}`, {});
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timeout" : (e?.message || String(e));
      return errorResult(name, msg, { address: args?.address ?? "" });
    }
  };
}

function ensureObject(o) {
  if (o == null || typeof o !== "object" || Array.isArray(o)) return {};
  return JSON.parse(JSON.stringify(o));
}

function successResult(data, toolName) {
  const plain = ensureObject(data);
  const structuredContent = coerceToOutputSchema(toolName, plain);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/** Error structuredContent must match each tool's outputSchema types exactly (numbers not strings). */
function errorResult(toolName, msg, ctx = {}) {
  let structuredContent;
  if (toolName === "whale_intel_report") {
    structuredContent = {
      address: String(ctx?.address ?? ""),
      risk_level: "MEDIUM",
      copy_trade_signal: "NEUTRAL",
      total_txs: 0,
      total_in_eth: 0,
      total_out_eth: 0,
      unique_counterparties: 0,
      agent_summary: String(msg),
      entity_cluster: {
        cluster_id: null,
        confidence: 0,
        connected_wallets: [],
        signals_used: [],
      },
      behavioral_profile: {
        type: "Individual Whale",
        confidence: 0,
        reasoning: [],
      },
    };
  } else if (toolName === "compare_whales") {
    structuredContent = {
      wallets: [],
      ranking: [],
      best_for_copy_trading: null,
      comparison_summary: String(msg),
    };
  } else {
    structuredContent = {
      address: String(ctx?.address ?? ""),
      risk_level: "MEDIUM",
      copy_trade_signal: "NEUTRAL",
      one_line_rationale: String(msg),
      agent_summary: String(msg),
    };
  }
  return {
    content: [{ type: "text", text: msg }],
    structuredContent: ensureObject(structuredContent),
    isError: true,
  };
}

export function isInitRequest(body) {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return isInitializeRequest(body);
}

export function getTransport(sessionId, body) {
  if (sessionId && transports[sessionId]) return transports[sessionId];

  if (!sessionId && isInitRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
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
    return transport;
  }

  return null;
}

export async function connectAndHandle(transport, req, res, body) {
  if (!transport.sessionId) {
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
  }
  await transport.handleRequest(req, res, body ?? {});
}
