# apps/ws-server/Dockerfile
# Build context must be the monorepo root so we can copy the shared proto package.
# See docker-compose.yml: context: .

FROM node:20-alpine AS deps
WORKDIR /app

# Copy the shared proto package so npm can resolve @notifyflow/proto locally.
COPY packages/proto ./packages/proto

# Copy ws-server package manifest and install production deps.
COPY apps/ws-server/package*.json ./
RUN npm install --only=production

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY apps/ws-server/src ./src

RUN addgroup -S notifyflow && adduser -S notifyflow -G notifyflow
USER notifyflow

EXPOSE 3001

CMD ["node", "src/server.js"]
