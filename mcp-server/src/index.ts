/**
 * WhaleMind MCP Server — Giga-brained, marketplace-competitive tools.
 * Combines multiple API calls, adds interpretation (risk, copy-trade signals),
 * and returns rich structured insights, not raw passthroughs.
 */

import "dotenv/config";
import type { Request, Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { statelessHandler } from "express-mcp-handler";
import { z } from "zod";

// Optional: Context Protocol JWT middleware for paid tools (install @ctxprotocol/sdk)
let contextMiddleware: ((req: Request, res: Response, next: () => void) => void) | null = null;
try {
  const { createContextMiddleware } = await import("@ctxprotocol/sdk");
  contextMiddleware = createContextMiddleware();
} catch {
  console.error("Optional: install @ctxprotocol/sdk for Context marketplace JWT verification.");
}

const WHALEMIND_API_URL = process.env.WHalemind_API_URL || process.env.WHALEMIND_API_URL || "";
const PORT = parseInt(process.env.PORT || "3010", 10);
const FETCH_TIMEOUT_MS = 55_000;

if (!WHALEMIND_API_URL) {
  console.warn("WHalemind_API_URL not set. Set it to your Railway API URL.");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const url = `${WHALEMIND_API_URL.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    method: options?.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhaleMind API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface AnalyzeResponse {
  address?: string;
  verdict?: string;
  confidence?: number;
  entity_type?: string;
  summary?: string;
  last_updated?: string;
  data_source?: string;
}

interface BalanceResponse {
  address?: string;
  balance_wei?: string;
}

// ---------------------------------------------------------------------------
// Interpretation layer (giga-brained: turn raw verdicts into actionable signals)
// ---------------------------------------------------------------------------

const VERDICT_RISK: Record<string, "LOW" | "MEDIUM" | "HIGH"> = {
  SMART_MONEY_ACCUMULATION: "LOW",
  WHALE_DORMANT: "LOW",
  NEUTRAL: "MEDIUM",
  EXCHANGE_ROTATION: "MEDIUM",
  STEALTH_DISTRIBUTION: "HIGH",
};

const VERDICT_COPY_SIGNAL: Record<string, "STRONG_BUY" | "BUY" | "WATCH" | "AVOID" | "NEUTRAL"> = {
  SMART_MONEY_ACCUMULATION: "STRONG_BUY",
  WHALE_DORMANT: "WATCH",
  NEUTRAL: "NEUTRAL",
  EXCHANGE_ROTATION: "WATCH",
  STEALTH_DISTRIBUTION: "AVOID",
};

const VERDICT_SMART_MONEY_SCORE: Record<string, number> = {
  SMART_MONEY_ACCUMULATION: 90,
  WHALE_DORMANT: 50,
  NEUTRAL: 50,
  EXCHANGE_ROTATION: 35,
  STEALTH_DISTRIBUTION: 15,
};

function getRiskLevel(verdict: string): "LOW" | "MEDIUM" | "HIGH" {
  return VERDICT_RISK[verdict] ?? "MEDIUM";
}

function getCopyTradeSignal(verdict: string, confidence: number): "STRONG_BUY" | "BUY" | "WATCH" | "AVOID" | "NEUTRAL" {
  const base = VERDICT_COPY_SIGNAL[verdict] ?? "NEUTRAL";
  if (base === "STRONG_BUY" && confidence >= 0.7) return "STRONG_BUY";
  if (base === "STRONG_BUY") return "BUY";
  return base;
}

function getSmartMoneyScore(verdict: string, confidence: number): number {
  const base = VERDICT_SMART_MONEY_SCORE[verdict] ?? 50;
  return Math.round(base * confidence);
}

function oneLineRationale(verdict: string, confidence: number, entityType?: string): string {
  const sig = getCopyTradeSignal(verdict, confidence);
  const entity = entityType ? ` (${entityType})` : "";
  return `${sig}: ${verdict}${entity}, confidence ${Math.round(confidence * 100)}%.`;
}

// ---------------------------------------------------------------------------
// Tool 1: Whale Intel Report — full report with balance and interpretation
// ---------------------------------------------------------------------------

const WhaleIntelReportOutputSchema = z.object({
  address: z.string(),
  verdict: z.string(),
  confidence: z.number(),
  entity_type: z.string(),
  summary: z.string(),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
  copy_trade_signal: z.enum(["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"]),
  balance_wei: z.string().optional(),
  agent_summary: z.string(),
  last_updated: z.string().optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool 2: Compare Whales — multi-wallet ranking and best-for-copy
// ---------------------------------------------------------------------------

const CompareWhalesOutputSchema = z.object({
  wallets: z.array(z.object({
    address: z.string(),
    verdict: z.string(),
    confidence: z.number(),
    entity_type: z.string(),
    smart_money_score: z.number(),
    copy_trade_signal: z.string(),
  })),
  ranking: z.array(z.string()).describe("Addresses ordered by smart_money_score descending"),
  best_for_copy_trading: z.string().nullable(),
  comparison_summary: z.string(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool 3: Whale Risk Snapshot — quick copy-trade signal
// ---------------------------------------------------------------------------

const WhaleRiskSnapshotOutputSchema = z.object({
  address: z.string(),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
  copy_trade_signal: z.enum(["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"]),
  verdict: z.string(),
  confidence: z.number(),
  one_line_rationale: z.string(),
  agent_summary: z.string(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Shared: build structured error response (schema-compliant)
// ---------------------------------------------------------------------------

function structuredError<T extends Record<string, unknown>>(
  base: T,
  errorMessage: string
): T & { error: string } {
  return { ...base, error: errorMessage };
}

// ---------------------------------------------------------------------------
// Create MCP server with all tools
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "whalemind-mcp",
    version: "2.0.0",
  });

  // ---- Tool 1: Whale Intel Report ----
  server.registerTool(
    "whale_intel_report",
    {
      description:
        "Deep intelligence report for a single Ethereum wallet. Combines on-chain behavior classification, " +
        "entity inference, risk level, and copy-trade signal. Use when you need a full due-diligence report " +
        "or to decide whether to copy-trade a whale. Returns verdict, confidence, entity_type, summary, " +
        "risk_level (LOW/MEDIUM/HIGH), copy_trade_signal (STRONG_BUY/BUY/WATCH/AVOID/NEUTRAL), balance, and agent_summary.",
      inputSchema: z.object({
        address: z.string().describe("Ethereum address (0x...)"),
      }),
      outputSchema: WhaleIntelReportOutputSchema,
    },
    async ({ address }: { address: string }) => {
      const base = { address, verdict: "ERROR", confidence: 0, entity_type: "", summary: "", risk_level: "MEDIUM" as const, copy_trade_signal: "NEUTRAL" as const, agent_summary: "" };
      if (!WHALEMIND_API_URL) {
        return {
          content: [{ type: "text" as const, text: "Error: WHalemind_API_URL not set." }],
          structuredContent: structuredError(base, "WHalemind_API_URL not set"),
        };
      }
      try {
        const [analyzeRes, balanceRes] = await Promise.all([
          apiFetch<AnalyzeResponse>("/analyze", { method: "POST", body: { wallet: address } }),
          apiFetch<BalanceResponse>(`/wallet/${encodeURIComponent(address)}/balance`).catch(() => null),
        ]);
        const verdict = analyzeRes.verdict ?? "NEUTRAL";
        const confidence = typeof analyzeRes.confidence === "number" ? analyzeRes.confidence : 0.5;
        const entityType = analyzeRes.entity_type ?? "unknown";
        const summary = analyzeRes.summary ?? "";
        const riskLevel = getRiskLevel(verdict);
        const copySignal = getCopyTradeSignal(verdict, confidence);
        const agentSummary = `Whale ${address.slice(0, 10)}…: ${verdict} (${entityType}). ${copySignal}. ${summary ? summary.slice(0, 120) + "…" : "No summary."}`;
        const structured = {
          address: analyzeRes.address ?? address,
          verdict,
          confidence,
          entity_type: entityType,
          summary,
          risk_level: riskLevel,
          copy_trade_signal: copySignal,
          balance_wei: balanceRes?.balance_wei,
          agent_summary: agentSummary,
          last_updated: analyzeRes.last_updated,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? (err.name === "AbortError" ? "Request timeout" : err.message) : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          structuredContent: structuredError(base, msg),
        };
      }
    }
  );

  // ---- Tool 2: Compare Whales ----
  server.registerTool(
    "compare_whales",
    {
      description:
        "Compare 2–5 Ethereum wallets and rank them by smart-money score. Returns a ranking, " +
        "best_for_copy_trading recommendation, and a comparison_summary. Use when the user wants " +
        "to choose the best whale to copy or compare multiple addresses.",
      inputSchema: z.object({
        addresses: z.array(z.string()).min(2).max(5).describe("2 to 5 Ethereum addresses (0x...)"),
      }),
      outputSchema: CompareWhalesOutputSchema,
    },
    async ({ addresses }: { addresses: string[] }) => {
      const empty: z.infer<typeof CompareWhalesOutputSchema> = {
        wallets: [],
        ranking: [],
        best_for_copy_trading: null,
        comparison_summary: "",
      };
      if (!WHALEMIND_API_URL) {
        return {
          content: [{ type: "text" as const, text: "Error: WHalemind_API_URL not set." }],
          structuredContent: structuredError(empty, "WHalemind_API_URL not set"),
        };
      }
      try {
        const results = await Promise.all(
          addresses.map(async (addr) => {
            const res = await apiFetch<AnalyzeResponse>("/analyze", { method: "POST", body: { wallet: addr } });
            const verdict = res.verdict ?? "NEUTRAL";
            const confidence = typeof res.confidence === "number" ? res.confidence : 0.5;
            return {
              address: res.address ?? addr,
              verdict,
              confidence,
              entity_type: res.entity_type ?? "unknown",
              smart_money_score: getSmartMoneyScore(verdict, confidence),
              copy_trade_signal: getCopyTradeSignal(verdict, confidence),
            };
          })
        );
        const byScore = [...results].sort((a, b) => b.smart_money_score - a.smart_money_score);
        const ranking = byScore.map((w) => w.address);
        const best = byScore[0]?.copy_trade_signal === "STRONG_BUY" || byScore[0]?.copy_trade_signal === "BUY"
          ? byScore[0].address
          : null;
        const comparison_summary =
          best
            ? `Best for copy-trading: ${best.slice(0, 10)}… (${byScore[0]?.verdict}, score ${byScore[0]?.smart_money_score}). `
            : "" +
              `Ranked by smart-money score: ${byScore.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;
        const structured = {
          wallets: results,
          ranking,
          best_for_copy_trading: best,
          comparison_summary: comparison_summary.trim() || "No strong copy-trade candidate.",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? (err.name === "AbortError" ? "Request timeout" : err.message) : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          structuredContent: structuredError(empty, msg),
        };
      }
    }
  );

  // ---- Tool 3: Whale Risk Snapshot ----
  server.registerTool(
    "whale_risk_snapshot",
    {
      description:
        "Quick risk and copy-trade signal for one wallet. Lightweight: returns risk_level, " +
        "copy_trade_signal, one_line_rationale, and agent_summary. Use when you only need a fast " +
        "'should I copy this wallet?' answer without full report or balance.",
      inputSchema: z.object({
        address: z.string().describe("Ethereum address (0x...)"),
      }),
      outputSchema: WhaleRiskSnapshotOutputSchema,
    },
    async ({ address }: { address: string }) => {
      const base = {
        address,
        risk_level: "MEDIUM" as const,
        copy_trade_signal: "NEUTRAL" as const,
        verdict: "ERROR",
        confidence: 0,
        one_line_rationale: "",
        agent_summary: "",
      };
      if (!WHALEMIND_API_URL) {
        return {
          content: [{ type: "text" as const, text: "Error: WHalemind_API_URL not set." }],
          structuredContent: structuredError(base, "WHalemind_API_URL not set"),
        };
      }
      try {
        const res = await apiFetch<AnalyzeResponse>("/analyze", { method: "POST", body: { wallet: address } });
        const verdict = res.verdict ?? "NEUTRAL";
        const confidence = typeof res.confidence === "number" ? res.confidence : 0.5;
        const entityType = res.entity_type;
        const riskLevel = getRiskLevel(verdict);
        const copySignal = getCopyTradeSignal(verdict, confidence);
        const oneLine = oneLineRationale(verdict, confidence, entityType);
        const agentSummary = `${copySignal}: ${address.slice(0, 10)}… — ${oneLine}`;
        const structured = {
          address: res.address ?? address,
          risk_level: riskLevel,
          copy_trade_signal: copySignal,
          verdict,
          confidence,
          one_line_rationale: oneLine,
          agent_summary: agentSummary,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? (err.name === "AbortError" ? "Request timeout" : err.message) : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          structuredContent: structuredError(base, msg),
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "WhaleMind MCP Server",
    whalemind_configured: !!WHALEMIND_API_URL,
    tools: ["whale_intel_report", "compare_whales", "whale_risk_snapshot"],
  });
});

if (contextMiddleware) {
  app.use("/mcp", contextMiddleware);
}

app.post("/mcp", statelessHandler(createMcpServer, {
  onError: (err: Error) => console.error("MCP error:", err),
}));

app.listen(PORT, () => {
  console.error(`WhaleMind MCP Server listening on port ${PORT}`);
  console.error(`  Tools: whale_intel_report | compare_whales | whale_risk_snapshot`);
  if (!WHALEMIND_API_URL) console.error(`  Warning: WHalemind_API_URL not set`);
});
