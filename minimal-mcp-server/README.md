# Minimal MCP Server

A minimal, production-ready MCP server using the official `@modelcontextprotocol/sdk`. Context Protocol compliant.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Endpoints

| Method | Path   | Description                          |
|--------|--------|--------------------------------------|
| GET    | /health| Health check → `{ "status": "ok" }` |
| POST   | /mcp   | MCP endpoint (initialize, tools/list, tools/call) |
| GET    | /mcp   | 405 Method Not Allowed              |
| DELETE | /mcp   | 405 Method Not Allowed              |

## Tool: ping

- **inputSchema**: `{ message?: string }`
- **outputSchema**: `{ reply: string }` (required)
- **structuredContent**: Always returns `{ reply: "pong" }` or `{ reply: "pong: <message>" }`

## Railway

Uses `process.env.PORT`, binds to `0.0.0.0`. No config needed.

## Test

```bash
# Health
curl http://localhost:3000/health

# MCP initialize (requires Accept: application/json, text/event-stream)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```
