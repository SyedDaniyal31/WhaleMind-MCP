# MCP server — Node 20 (use when Root Directory = mcp-server-js)
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 3000
ENV NODE_ENV=production
ENV HOST=0.0.0.0
CMD ["node", "server.js"]
