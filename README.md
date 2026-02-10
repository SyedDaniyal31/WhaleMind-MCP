# WhaleMind MCP Backend

Flask API for wallet behavior analysis. See [INSTALL.md](INSTALL.md) for setup.

## Quick Start

```bash
pip install -r requirements.txt
cp .env.example .env   # Edit with your API keys
python api.py
```

## Deploy (Railway/Render)

**Flask API:** Set `ETHERSCAN_API_KEY` and `DATABASE_URL` in environment; Procfile: `web: gunicorn api:app`.

**MCP server (Node):** Deploy from this repo with Railway → Settings → **Dockerfile path** = `Dockerfile.mcp`, **Start command** = `node server.js`. See [mcp-server-js/RAILWAY-DEPLOY.md](mcp-server-js/RAILWAY-DEPLOY.md).
