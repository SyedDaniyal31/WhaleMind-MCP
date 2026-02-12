# MCP Server Reference

**A bridge between AI and the real world** — Reference implementation following the MCP architecture.

---

## What is an MCP Server?

An MCP server lets AI models (ChatGPT, Claude, agents) safely interact with external tools, APIs, and data sources.

| Without MCP | With MCP |
|-------------|----------|
| AI = Brain with no internet | AI + MCP = Brain + APIs + Tools |
| Can only use training data | Can fetch live data, analyze, act |

---

## Flow

```
1️⃣ Client connects → POST /mcp with initialize
   → Session starts

2️⃣ Tool discovery → tools/list
   → Server returns: tool names, descriptions, inputSchema, outputSchema

3️⃣ Tool execution → tools/call with { name, arguments }
   → Server runs logic, returns structuredContent

4️⃣ AI uses result → Reads structuredContent → Gives user smart answer
```

---

## Security Model

| Method       | Auth? | Why                    |
|-------------|-------|------------------------|
| initialize  | No    | Session setup          |
| tools/list  | No    | Discovery              |
| tools/call  | Yes   | Executes code, may cost |

For paid tools, Context Protocol adds JWT verification and payment handling.

---

## Tools

| Tool             | Description                          |
|------------------|--------------------------------------|
| `get_gas_price`  | Ethereum gas price in gwei           |
| `analyze_wallet` | Deep behavioral analysis of a wallet |
| `whale_alerts`   | Large transactions and movements     |

---

## Run

```bash
cd mcp-server-reference
npm install
npm start
```

- **Health:** `GET http://localhost:3000/health`
- **MCP:** `POST http://localhost:3000/mcp`

### Local testing (no JWT)

```bash
SKIP_CONTEXT_AUTH=true npm start
```

---

## Architecture

```
User
  ↓
AI Agent
  ↓
MCP Client
  ↓
MCP Server (/mcp)
  ↓
External APIs (Etherscan, etc.)
```

---

## Example tools/call

```json
{
  "method": "tools/call",
  "params": {
    "name": "analyze_wallet",
    "arguments": {
      "address": "0x123..."
    }
  }
}
```

Server returns:

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "structuredContent": {
    "address": "0x123...",
    "risk_level": "LOW",
    "copy_trade_signal": "BUY",
    "total_txs": 42,
    "agent_summary": "..."
  }
}
```
