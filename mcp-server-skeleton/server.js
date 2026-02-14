/**
 * MCP server skeleton: single POST /mcp, JSON-RPC 2.0.
 * Handles: initialize, tools/list, tools/call.
 * Low latency, caching, strict validation, structured logging.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { listTools, executeTool } from "./tools.js";
import { parseRpcRequest } from "./schemas.js";
import { get, set, cacheKey } from "./cache.js";

const APP_PORT = Number(process.env.PORT) || 3000;
const inFlight = new Map();
const CACHE_TTL_MS = Number(process.env.MCP_CACHE_TTL_MS) || 60_000; // 30–120s

const app = express();
app.use(express.json({ limit: "256kb" }));

function log(level, requestId, method, message, meta = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    requestId,
    method: method ?? null,
    ...meta,
    msg: message,
  });
  console[level === "error" ? "error" : "log"](line);
}

app.post("/mcp", async (req, res) => {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const start = Date.now();
  let method = null;
  let cacheHit = false;

  try {
    const body = req.body;
    const parsed = parseRpcRequest(body);
    if (!parsed.success) {
      log("warn", requestId, null, "Invalid JSON-RPC body", { latencyMs: Date.now() - start });
      return res.status(400).json({
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32700, message: "Parse error", data: { hint: "Body must be valid JSON-RPC 2.0 with method." } },
      });
    }

    const { id, method: rpcMethod, params } = parsed.data;
    method = rpcMethod;

    if (rpcMethod === "initialize") {
      const result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-skeleton", version: "1.0.0" },
      };
      log("info", requestId, rpcMethod, "init", { latencyMs: Date.now() - start });
      return res.json({ jsonrpc: "2.0", id, result });
    }

    if (rpcMethod === "tools/list") {
      const result = { tools: listTools() };
      log("info", requestId, rpcMethod, "tools/list", { latencyMs: Date.now() - start });
      return res.json({ jsonrpc: "2.0", id, result });
    }

    if (rpcMethod === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? params?.params ?? {};
      const key = cacheKey("tools/call", { name, arguments: args });

      const cached = get(key, CACHE_TTL_MS);
      if (cached !== null) {
        cacheHit = true;
        log("info", requestId, "tools/call", "cached", { latencyMs: Date.now() - start, cacheHit: true });
        return res.json({ jsonrpc: "2.0", id, result: cached });
      }

      let promise = inFlight.get(key);
      if (!promise) {
        promise = runToolCall(name, args).then((payload) => {
          inFlight.delete(key);
          if (!payload.error) set(key, payload.result, CACHE_TTL_MS);
          return payload;
        });
        inFlight.set(key, promise);
      }
      const payload = await promise;
      if (payload.error) {
        log("warn", requestId, "tools/call", "tool error", { latencyMs: Date.now() - start, code: payload.error.code });
        return res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: payload.error.code === -32602 ? -32602 : -32000,
            message: payload.error.message,
            data: payload.error.data,
          },
        });
      }
      log("info", requestId, "tools/call", "ok", { latencyMs: Date.now() - start, cacheHit: false });
      return res.json({ jsonrpc: "2.0", id, result: payload.result });
    }

    log("warn", requestId, rpcMethod, "Unknown method");
    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found", data: { method: rpcMethod } },
    });
  } catch (err) {
    log("error", requestId, method, err?.message ?? String(err), { latencyMs: Date.now() - start });
    return res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32603, message: "Internal error", data: { requestId } },
    });
  }
});

async function runToolCall(name, args) {
  const out = await executeTool(name, args);
  if (out.error) return out;
  const result = {
    content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }],
    structuredContent: out.result,
  };
  return { result };
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(APP_PORT, () => {
  console.log(JSON.stringify({ msg: "MCP skeleton listening", port: APP_PORT }));
});
