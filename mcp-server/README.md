# WhaleMind MCP Server

Context Protocol–compliant MCP server wrapping the WhaleMind wallet analysis API. Uses Streamable HTTP transport.

## Setup

```bash
cd mcp-server
npm install
cp .env.example .env
# Edit .env: set WHalemind_API_URL to your Railway API URL
```

## Run

```bash
npm run dev    # Development (tsx watch)
npm run build && npm start   # Production
```

## Endpoints

| Endpoint      | Method | Description                       |
|---------------|--------|-----------------------------------|
| `/health`     | GET    | Health check                      |
| `/mcp`        | POST   | MCP Streamable HTTP (listTools, callTool) |

## Environment Variables

| Variable           | Required | Description                            |
|--------------------|----------|----------------------------------------|
| `WHalemind_API_URL`| Yes      | WhaleMind Railway API base URL         |
| `PORT`             | No       | Server port (default: 3010)            |

## Tool: analyze_wallet

- **Input**: `address` (string), `limit` (number, optional, default 20)
- **Output**: `address`, `behavior`, `verdict`, `confidence`

Fetches wallet analysis from `{WHalemind_API_URL}/wallet/{address}?limit={limit}`.

## MCP Compliance

- Uses Streamable HTTP transport via `express-mcp-handler`
- Implements `listTools` (returns `analyze_wallet`)
- Tool call fetches WhaleMind API, formats response, returns `structuredContent`
