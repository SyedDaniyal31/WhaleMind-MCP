/**
 * WhaleMind MCP Server — production-ready, MCP-compliant
 * Entry: src/server.js
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { contextAuth } from "./middleware/auth.js";
import { getTransport, connectAndHandle, isInitRequest } from "./mcpHandler.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const app = express();

// ─── Middleware (order matters) ─────────────────────────────────────────────
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "mcp-session-id"],
  })
);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[MCP] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use(express.json({ limit: "1mb" }));

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.redirect(301, "/health"));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "WhaleMind MCP Server",
    mcp: "POST /mcp (initialize, tools/list, tools/call)",
  });
});

// MCP endpoint — POST only for JSON-RPC; GET returns 405 with clear message
app.use("/mcp", contextAuth);

app.post("/mcp", async (req, res) => {
  const ct = (req.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    res.status(415).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Content-Type must be application/json" },
      id: null,
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const body = req.body ?? {};
  const transport = getTransport(sessionId, body);

  if (!transport) {
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
    await connectAndHandle(transport, req, res, body);
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

app.options("/mcp", (_req, res) => {
  res.set("Allow", "POST").status(204).end();
});

app.get("/mcp", (_req, res) => {
  res.set("Allow", "POST").status(405).type("text/plain").send("MCP endpoint — use POST");
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
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

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[MCP] WhaleMind MCP Server running on ${HOST}:${PORT}`);
  console.log("[MCP] Endpoints: GET /health, POST /mcp (initialize, tools/list, tools/call)");
});
