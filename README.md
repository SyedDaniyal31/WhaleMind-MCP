# WhaleMind MCP Backend

Flask API for wallet behavior analysis and a Node.js MCP server for whale/smart-money tools. See [INSTALL.md](INSTALL.md) for Flask setup.

## Quick Start

**Flask API:**

```bash
pip install -r requirements.txt
cp .env.example .env   # Edit with your API keys
python api.py
```

**MCP Server (Node.js, Blocknative-style):**

```bash
cd mcp-server-js
npm install
cp .env.example .env   # Optional: ETHERSCAN_API_KEY, WHALEMIND_API_URL
npm start
```

- Health: `GET /health` → `OK`
- MCP: `POST /mcp` (Streamable HTTP; methods: `initialize`, `tools/list`, `tools/call`)
- Tools: `whale_intel_report`, `compare_whales`, `whale_risk_snapshot`

See [mcp-server-js/README.md](mcp-server-js/README.md) for full MCP docs.

## Deploy (Railway/Render)

**Flask API:** Set `ETHERSCAN_API_KEY` and `DATABASE_URL` in environment; Procfile: `web: gunicorn api:app`.

**MCP server (Node):** Full step-by-step → **[RAILWAY-DEPLOY-STEPS.md](RAILWAY-DEPLOY-STEPS.md)**. Short: Railway → **Root Directory** = `mcp-server-js`, **Start command** = `node src/server.js`.
