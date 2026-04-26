# apps/worker/Dockerfile
# Build context must be the monorepo root (set in docker-compose.yml: context: .)
# so that we can copy the worker source, shared API models, AND the shared proto package.

FROM node:20-alpine AS deps
WORKDIR /app

# Copy the shared proto package so npm can resolve @notifyflow/proto locally.
COPY packages/proto ./packages/proto

# Copy worker package manifest and install production deps.
COPY apps/worker/package*.json ./
RUN npm install --only=production

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages

# Worker source files
COPY apps/worker/src ./src

# Shared API models, config, and utils (worker imports these at runtime)
COPY apps/api/src/models  ./api-models
COPY apps/api/src/config  ./api-config
COPY apps/api/src/utils   ./api-utils

# Tell the worker where to find models at runtime (overrides the local-dev relative path)
ENV API_MODELS_PATH=/app/api-models
ENV API_CONFIG_PATH=/app/api-config

RUN addgroup -S notifyflow && adduser -S notifyflow -G notifyflow
USER notifyflow

CMD ["node", "src/worker.js"]
