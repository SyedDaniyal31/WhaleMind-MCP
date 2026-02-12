FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

# Entry: src/server.js (rebuild)
CMD ["node", "src/server.js"]
