/**
 * Minimal MCP Server — Context Protocol compliant
 * Uses official @modelcontextprotocol/sdk. No custom JSON-RPC.
 */
import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

// ---------------------------------------------------------------------------
// MCP Server (created per request for stateless operation)
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer(
    { name: "minimal-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "ping",
    {
      description: "Returns a simple pong response.",
      inputSchema: {
        message: z.string().optional().describe("Optional message to echo"),
      },
      outputSchema: {
        reply: z.string(),
      },
    },
    async ({ message }) => {
      const reply = message ? `pong: ${message}` : "pong";
      return {
        content: [{ type: "text", text: reply }],
        structuredContent: { reply },
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).send("Method Not Allowed. Use POST.");
});

app.delete("/mcp", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).send("Method Not Allowed. Use POST.");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  console.log(`MCP Server listening on http://${HOST}:${PORT}`);
  console.log("  GET  /health  — health check");
  console.log("  POST /mcp     — MCP endpoint (initialize, tools/list, tools/call)");
});
