/**
 * Context Protocol auth middleware.
 * - initialize, tools/list: no JWT required
 * - tools/call: JWT required (verified by createContextMiddleware)
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
