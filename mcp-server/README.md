# WhaleMind MCP Server

Giga-brained MCP tools for whale/smart-money intelligence. Combines multiple API calls, adds risk and copy-trade signals, and returns rich structured insights. Streamable HTTP transport.

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
| `/health`     | GET    | Health check (+ tool list)        |
| `/mcp`        | POST   | MCP Streamable HTTP (listTools, callTool) |

## Environment Variables

| Variable           | Required | Description                            |
|--------------------|----------|----------------------------------------|
| `WHalemind_API_URL`| Yes      | WhaleMind Railway API base URL         |
| `PORT`             | No       | Server port (default: 3010)            |

## Tools (marketplace-competitive)

### 1. `whale_intel_report`
**Deep due-diligence for one wallet.**  
- **Input**: `address` (string)  
- **Behavior**: Calls POST `/analyze` + GET `/wallet/{address}/balance` in parallel.  
- **Output**: `verdict`, `confidence`, `entity_type`, `summary`, `risk_level` (LOW/MEDIUM/HIGH), `copy_trade_signal` (STRONG_BUY/BUY/WATCH/AVOID/NEUTRAL), `balance_wei`, `agent_summary`, `last_updated`.  
- **Use when**: Full report or “should I copy this whale?” with balance.

### 2. `compare_whales`
**Compare 2–5 wallets and rank by smart-money score.**  
- **Input**: `addresses` (array of 2–5 Ethereum addresses)  
- **Behavior**: Calls POST `/analyze` for each address in parallel.  
- **Output**: `wallets` (with verdict, confidence, entity_type, smart_money_score, copy_trade_signal), `ranking` (addresses by score), `best_for_copy_trading`, `comparison_summary`.  
- **Use when**: User wants to choose the best whale to copy or compare several addresses.

### 3. `whale_risk_snapshot`
**Quick copy-trade signal for one wallet.**  
- **Input**: `address` (string)  
- **Behavior**: Calls POST `/analyze` only.  
- **Output**: `risk_level`, `copy_trade_signal`, `one_line_rationale`, `verdict`, `confidence`, `agent_summary`.  
- **Use when**: Fast “should I copy this?” without full report or balance.

## MCP Compliance

- Streamable HTTP via `express-mcp-handler`
- All tools declare `outputSchema` and return `structuredContent` matching it
- Optional `@ctxprotocol/sdk` middleware for Context marketplace JWT
