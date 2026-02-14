# MCP Server Skeleton

Minimal production-ready MCP server: low latency, caching, strict schema validation, zero-shot agent design.

## Run

```bash
npm install
node server.js
```

- **Endpoint:** `POST /mcp` (JSON-RPC 2.0)
- **Port:** `3000` (or `PORT` env)
- **Health:** `GET /health`

## Methods

| Method         | Description                    |
|----------------|--------------------------------|
| `initialize`   | Handshake, capabilities        |
| `tools/list`   | List tools                     |
| `tools/call`   | Execute tool (cached, deduped) |

## Example: tools/call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_wallet",
    "arguments": { "wallet_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }
  }
}
```

## Error codes

- `-32602` Invalid params (e.g. bad wallet_address)
- `-32601` Method not found / Unknown tool
- `-32000` Tool execution error

## Env

- `PORT` — Server port (default 3000)
- `MCP_CACHE_TTL_MS` — Cache TTL for tools/call (default 60000, use 30000–120000)

## Layout

- `server.js` — Express, POST /mcp, routing, logging, cache + dedupe
- `tools.js` — Tool definitions, executeTool (mock)
- `schemas.js` — Zod validation (input/output, JSON-RPC)
- `cache.js` — TTL cache + optional getOrSet deduplication
