FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend
COPY frontend ./frontend
COPY tsconfig.json ./

EXPOSE 3000

# Generates backend/keys/ on first boot only (script is idempotent), then
# starts the server. Keys live on a named volume (see docker-compose.yml)
# so they persist across container recreates — regenerating them would
# make every previously issued certificate fail verification.
CMD ["sh", "-c", "node backend/scripts/generate-keys.js && npx tsx backend/server.ts"]
