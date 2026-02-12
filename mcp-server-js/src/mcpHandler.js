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
  return {
    content: [{ type: "text", text: JSON.stringify(plain, null, 2) }],
    structuredContent: plain,
  };
}

function errorResult(toolName, msg, ctx = {}) {
  const schema = toolName === "compare_whales" ? { comparison_summary: msg } : { address: ctx?.address ?? "", agent_summary: msg, one_line_rationale: msg };
  return {
    content: [{ type: "text", text: msg }],
    structuredContent: ensureObject(schema),
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
