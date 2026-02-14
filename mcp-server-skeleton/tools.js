/**
 * Tool definitions and execution. Mock only; no business logic.
 * Structure optimized for zero-shot agent success.
 */

import { validateAnalyzeWalletInput, validateAnalyzeWalletOutput } from "./schemas.js";

const ETH_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";

export const TOOL_DEFINITIONS = [
  {
    name: "analyze_wallet",
    description:
      "Get a risk and entity summary for ONE Ethereum wallet address. Use when the user asks to analyze, check, or assess a single wallet. Does NOT compare multiple wallets; does NOT analyze blocks or transactions. Example input: { \"wallet_address\": \"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\" }.",
    inputSchema: {
      type: "object",
      properties: {
        wallet_address: {
          type: "string",
          description: "Single Ethereum wallet address. Must be 0x followed by exactly 40 hexadecimal characters.",
          pattern: ETH_ADDRESS_PATTERN,
          examples: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
        },
      },
      required: ["wallet_address"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        entity_type: { type: "string" },
        risk_level: { type: "string" },
        confidence: { type: "number" },
        summary: { type: "string" },
      },
      required: ["entity_type", "risk_level", "confidence", "summary"],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) ?? null;
}

export function listTools() {
  return TOOL_DEFINITIONS;
}

/**
 * Execute tool by name with params. Returns mock data; validates input with Zod.
 */
export async function executeTool(name, params) {
  const tool = getTool(name);
  if (!tool) return { error: { code: -32601, message: "Unknown tool" } };

  if (name === "analyze_wallet") {
    const parsed = validateAnalyzeWalletInput(params);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors?.wallet_address?.[0] ?? parsed.error.message;
      return { error: { code: -32602, message: "Invalid params", data: { hint: first } } };
    }
    const { wallet_address } = parsed.data;
    const mock = {
      entity_type: "Unknown",
      risk_level: "MEDIUM",
      confidence: 0.5,
      summary: "Mock analysis for " + wallet_address.slice(0, 10) + "... (skeleton; no real logic).",
    };
    const out = validateAnalyzeWalletOutput(mock);
    return { result: out.success ? out.data : mock };
  }

  return { error: { code: -32601, message: "Unknown tool" } };
}
