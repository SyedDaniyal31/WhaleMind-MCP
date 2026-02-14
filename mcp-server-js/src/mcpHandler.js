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
  validateToolInput,
  runWhaleIntelReport,
  runCompareWhales,
  runWhaleRiskSnapshot,
  runDetectMevBundles,
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
    const toolName = typeof name === "string" ? name : "whale_intel_report";
    const safeName = TOOL_DEFINITIONS.some((t) => t.name === toolName) ? toolName : "whale_intel_report";

    try {
      const validation = validateToolInput(toolName, args);
      if (!validation.valid) {
        const message = validation.hint ? `${validation.error} ${validation.hint}` : validation.error;
        return errorResult(safeName, message, { hint: validation.hint });
      }

      switch (toolName) {
        case "whale_intel_report": {
          const addr = (args?.address ?? "").trim();
          const limit = typeof args?.limit === "number" && args.limit >= 1 && args.limit <= 10000 ? args.limit : 2000;
          return successResult(await runWhaleIntelReport(addr, limit), toolName);
        }
        case "compare_whales": {
          const addrs = Array.isArray(args?.addresses) ? args.addresses : [];
          return successResult(await runCompareWhales(addrs), toolName);
        }
        case "whale_risk_snapshot": {
          const addr = (args?.address ?? "").trim();
          return successResult(await runWhaleRiskSnapshot(addr), toolName);
        }
        case "detect_mev_bundles": {
          return successResult(
            await runDetectMevBundles({
              block_number: args?.block_number,
              transactions: args?.transactions,
              min_confidence: args?.min_confidence,
            }),
            toolName
          );
        }
        default:
          return errorResult("whale_intel_report", `Unknown tool: ${toolName}. Valid tools: whale_intel_report, compare_whales, whale_risk_snapshot, detect_mev_bundles.`, {});
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timeout; try again or use a smaller limit." : (e?.message || String(e));
      return errorResult(safeName, msg, { address: args?.address ?? "" });
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
    const emptyFeatureSummary = {
      activity_metrics: { wallet_age_days: 0, active_days_ratio: 0, avg_tx_per_day: 0, tx_frequency_std_dev: 0 },
      volume_metrics: { lifetime_volume_eth: 0, avg_tx_size: 0, median_tx_size: 0, max_single_tx: 0 },
      network_metrics: { unique_counterparties: 0, repeat_counterparty_ratio: 0, top_5_counterparty_share: 0 },
      behavioral_metrics: { dex_interaction_ratio: 0, cex_interaction_ratio: 0, contract_call_ratio: 0, same_block_multi_tx_count: 0 },
      temporal_metrics: { burst_activity_score: 0, weekly_activity_pattern: [0, 0, 0, 0, 0, 0, 0] },
    };
    structuredContent = {
      address: String(ctx?.address ?? ""),
      risk_level: "MEDIUM",
      copy_trade_signal: "NEUTRAL",
      total_txs: 0,
      total_in_eth: 0,
      total_out_eth: 0,
      unique_counterparties: 0,
      agent_summary: String(msg),
      entity_type: "Unknown",
      confidence_score: 0,
      confidence_reasons: [],
      cluster_data: {
        cluster_id: null,
        cluster_size: 0,
        related_wallets: [],
        cluster_confidence: 0,
      },
      risk_profile: {
        market_impact_risk: { score: 0.5, label: "MEDIUM" },
        counterparty_risk: { score: 0.5, label: "MEDIUM" },
        behavioral_risk: { score: 0.5, label: "MEDIUM" },
      },
      feature_summary: emptyFeatureSummary,
      entity_cluster: {
        cluster_id: null,
        confidence: 0,
        connected_wallets: [],
        signals_used: [],
      },
      behavioral_profile: {
        type: "Unknown",
        confidence: 0,
        reasoning: [],
      },
      entity_fingerprint: {
        entity_type: "Unknown",
        confidence_score: 0,
        supporting_signals: [],
        entity_cluster_id: null,
        scores: {},
      },
      tx_fetch_summary: {
        total_fetched: 0,
        pages_fetched: 0,
        truncated: false,
        sampled: false,
        full_history: false,
      },
    };
  } else if (toolName === "compare_whales") {
    structuredContent = {
      wallets: [],
      ranking: [],
      best_for_copy_trading: null,
      comparison_summary: String(msg),
    };
  } else if (toolName === "detect_mev_bundles") {
    structuredContent = {
      block_number: null,
      block_tx_count: 0,
      bundle_confidence_score: null,
      bundle_type: null,
      best_bundle: null,
      bundles: [],
      error: String(msg),
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
    structuredContent: coerceToOutputSchema(toolName, structuredContent),
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
