/**
 * WhaleMind MCP Server
 * Context Protocol–compliant MCP server wrapping the WhaleMind wallet analysis API.
 * Uses Streamable HTTP transport via express-mcp-handler.
 */

import "dotenv/config";
import type { Request, Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { statelessHandler } from "express-mcp-handler";
import { z } from "zod";

const WHALEMIND_API_URL = process.env.WHalemind_API_URL || process.env.WHALEMIND_API_URL || "";
const PORT = parseInt(process.env.PORT || "3010", 10);

if (!WHALEMIND_API_URL) {
  console.warn("WHalemind_API_URL not set. Set it to your Railway API URL.");
}

/**
 * Fetch wallet analysis from the WhaleMind Railway API.
 */
async function fetchWalletAnalysis(address: string, limit: number = 20): Promise<{
  address: string;
  behavior: Record<string, unknown>;
  verdict: string;
  confidence: number;
}> {
  const url = `${WHALEMIND_API_URL.replace(/\/$/, "")}/wallet/${encodeURIComponent(address)}?limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhaleMind API error ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    address: (data.address as string) || address,
    behavior: (data.behavior as Record<string, unknown>) || {},
    verdict: (data.verdict as string) || "NEUTRAL",
    confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
  };
}

/**
 * Create MCP server instance with tools.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "whalemind-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "analyze_wallet",
    {
      description: "Entity-level whale behavior intelligence. Analyzes on-chain wallet activity and returns behavior classification.",
      inputSchema: z.object({
        address: z.string().describe("Ethereum wallet address (0x...)"),
        limit: z.number().optional().describe("Max transactions to fetch (default 20)"),
      }),
      outputSchema: z.object({
        address: z.string(),
        behavior: z.record(z.unknown()),
        verdict: z.string(),
        confidence: z.number(),
      }),
    },
    async ({ address, limit }: { address: string; limit?: number }) => {
      const apiUrl = WHALEMIND_API_URL;
      if (!apiUrl) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: WHalemind_API_URL is not configured.",
            },
          ],
          structuredContent: {
            address,
            behavior: {},
            verdict: "ERROR",
            confidence: 0,
            error: "WHalemind_API_URL not set",
          },
        };
      }

      try {
        const result = await fetchWalletAnalysis(address, limit ?? 20);
        const structured = {
          address: result.address,
          behavior: result.behavior,
          verdict: result.verdict,
          confidence: result.confidence,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(structured, null, 2),
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          structuredContent: {
            address,
            behavior: {},
            verdict: "ERROR",
            confidence: 0,
            error: message,
          },
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Health endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "WhaleMind MCP Server",
    whalemind_configured: !!WHALEMIND_API_URL,
  });
});

// MCP endpoint – Streamable HTTP transport (stateless)
app.post("/mcp", statelessHandler(createMcpServer, {
  onError: (err: Error) => console.error("MCP error:", err),
}));

app.listen(PORT, () => {
  console.error(`WhaleMind MCP Server listening on port ${PORT}`);
  console.error(`  /health - health check`);
  console.error(`  POST /mcp - MCP Streamable HTTP endpoint`);
  if (!WHALEMIND_API_URL) {
    console.error(`  Warning: WHalemind_API_URL not set`);
  }
});
