# syntax=docker/dockerfile:1.7
# CineWave API image — one image runs the API (default), the worker (`node dist/worker.js`)
# and migrations (`npx prisma migrate deploy`). Debian slim matches the Prisma binary target
# (debian-openssl-3.0.x) and the prebuilt glibc binaries of sharp and @node-rs/argon2.

ARG NODE_VERSION=22.20.0

# ─── deps: full dependency tree (needed for tsc and prisma generate) ───
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ─── build: compile TypeScript and generate the Prisma client ───
FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ─── runtime ───
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    LOCAL_STORAGE_PATH=/app/storage/uploads \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
RUN mkdir -p /app/storage/uploads && chown -R node:node /app/storage

USER node
EXPOSE 4000
VOLUME ["/app/storage/uploads"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
