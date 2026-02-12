/**
 * Context Protocol auth middleware.
 *
 * MCP method auth (Context / dispute model):
 * - initialize         — no auth (session setup)
 * - tools/list        — no auth (discovery; agents need schemas)
 * - resources/list    — no auth (discovery)
 * - prompts/list      — no auth (discovery)
 * - tools/call        — JWT required (execution; costs money, runs code)
 *
 * createContextMiddleware verifies JWT only for tools/call.
 */
import { createContextMiddleware } from "@ctxprotocol/sdk";

const SKIP_AUTH = process.env.SKIP_CONTEXT_AUTH === "true";

if (SKIP_AUTH && process.env.NODE_ENV === "production") {
  console.error("[MCP] FATAL: SKIP_CONTEXT_AUTH must not be set in production!");
  process.exit(1);
}

const contextMiddleware = !SKIP_AUTH
  ? createContextMiddleware({ audience: process.env.MCP_ENDPOINT_URL || undefined })
  : null;

export function contextAuth(req, res, next) {
  if (SKIP_AUTH) {
    console.warn("[MCP] SKIP_CONTEXT_AUTH=true — JWT verification disabled (dev only)");
    return next();
  }
  return contextMiddleware(req, res, next);
}
