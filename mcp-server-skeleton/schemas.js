/**
 * Zod schemas for strict validation. MCP params and tool outputs.
 */

import { z } from "zod";

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

// ─── analyze_wallet ───────────────────────────────────────────────────────
export const AnalyzeWalletInputSchema = z.object({
  wallet_address: z
    .string()
    .min(1, "wallet_address is required")
    .regex(ETH_ADDRESS_REGEX, "wallet_address must be 0x followed by exactly 40 hex characters"),
});

export const AnalyzeWalletOutputSchema = z.object({
  entity_type: z.string(),
  risk_level: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

export function validateAnalyzeWalletInput(params) {
  return AnalyzeWalletInputSchema.safeParse(params);
}

export function validateAnalyzeWalletOutput(data) {
  return AnalyzeWalletOutputSchema.safeParse(data);
}

// ─── JSON-RPC request (minimal for MCP) ────────────────────────────────────
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.union([z.object({}).passthrough(), z.array(z.unknown())]).optional(),
});

export function parseRpcRequest(body) {
  return JsonRpcRequestSchema.safeParse(body);
}
