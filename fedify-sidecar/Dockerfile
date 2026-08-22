# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod || npm install --production

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S fedify -u 1001 -G nodejs

USER fedify

ENV NODE_ENV=production
ENV PORT=3001

# OS3: current Tier-3 public-query architecture is OpenSearch lexical/faceted.
# Explicit deployments can still override this environment variable for an
# isolated future-vector experiment, but the production image no longer falls
# into the historical dual/Qdrant topology when SEARCH_BACKEND is omitted.
ENV SEARCH_BACKEND=opensearch

# Node 22 provides native Zstandard support. Existing Redpanda evidence selected
# level 1 as the balanced event-log operating point.
ENV REDPANDA_COMPRESSION=zstd
ENV REDPANDA_ZSTD_LEVEL=1

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
