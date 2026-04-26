# apps/api/Dockerfile
# Build context must be the monorepo root so we can copy the shared proto package.
# See docker-compose.yml: context: .

FROM node:20-alpine AS deps
WORKDIR /app

# Copy the shared proto package so npm can resolve @notifyflow/proto locally.
COPY packages/proto ./packages/proto

# Copy the API package manifest and install production deps.
COPY apps/api/package*.json ./
RUN npm install --only=production

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY apps/api/src ./src

RUN addgroup -S notifyflow && adduser -S notifyflow -G notifyflow
USER notifyflow

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/app.js"]
