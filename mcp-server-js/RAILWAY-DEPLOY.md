# Deploy MCP server to Railway (fix "node/node: command not found")

Your **web** service is using an image that has no Node.js. Use **one** of these:

---

## Option A — Use root Dockerfile (no Root Directory change)

Works with your current setup (service building from repo root).

1. Open the **web** service → **Settings**.
2. **Build** section → set **Dockerfile Path** to: **`Dockerfile.mcp`**  
   (There is a `Dockerfile.mcp` at the repo root that builds the MCP server with Node 20.)
3. **Deploy** section → set **Start Command** to: **`node src/server.js`**
4. Leave **Root Directory** empty (or as is).
5. **Redeploy**.

The build will use `Dockerfile.mcp`, install Node and the app, and run `node src/server.js`.

---

## Option B — Build from mcp-server-js folder

1. **Settings** → **Root Directory** → set to: **`mcp-server-js`**
2. **Start Command** → **`node src/server.js`**
3. **Redeploy**. Railway will use the Dockerfile inside `mcp-server-js/`.

---

## Two apps in one repo?

- **Flask API** (api.py) → one service: Root Directory **empty**, no Dockerfile path (uses Procfile/Nixpacks).
- **MCP server** → same or second service: use **Option A** (Dockerfile path = `Dockerfile.mcp`) or **Option B** (Root Directory = `mcp-server-js`).
