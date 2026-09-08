# Self-hosted CoMaps traffic service.
#
# Build from tools/traffic_server:
#   docker build -t comaps-traffic .
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src

FROM node:24-alpine

RUN addgroup -S traffic && adduser -S traffic -G traffic
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json

# The index directory holds the .cmti artifacts you build offline, plus generated bodies and
# pairing state. Mount it as a volume so pairings survive a container restart.
ENV TRAFFIC_INDEX_DIR=/data
RUN mkdir -p /data && chown traffic:traffic /data
VOLUME ["/data"]

USER traffic
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sources run directly under type-stripping, so there is no build artifact to keep in sync.
CMD ["node", "--experimental-strip-types", "src/entry/node.ts"]
