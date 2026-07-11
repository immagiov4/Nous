ARG BUN_VERSION=1.3.13
FROM oven/bun:${BUN_VERSION}-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS web-build
COPY apps/web apps/web
COPY packages packages
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim AS frontend
WORKDIR /app
ENV NODE_ENV=production \
    FRONTEND_PORT=8080
COPY --from=web-build --chown=bun:bun /app/apps/web/dist apps/web/dist
COPY --chown=bun:bun scripts/serve-production-frontend.ts scripts/serve-production-frontend.ts
USER bun
EXPOSE 8080
CMD ["bun", "run", "scripts/serve-production-frontend.ts"]

FROM dependencies AS tooling
COPY deploy/config.mjs deploy/config.mjs
COPY deploy/health-smoke.mjs deploy/health-smoke.mjs
COPY supabase supabase
COPY scripts scripts

FROM tooling AS contract
COPY apps/backend apps/backend
COPY apps/web/vitest.config.ts apps/web/vitest.config.ts
COPY apps/web/tests/setup.ts apps/web/tests/setup.ts
COPY packages packages

FROM oven/bun:${BUN_VERSION}-slim AS backend
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=3301
COPY --from=dependencies --chown=bun:bun /app/node_modules node_modules
COPY --chown=bun:bun apps/backend/package.json apps/backend/package.json
COPY --chown=bun:bun apps/backend/src apps/backend/src
COPY --chown=bun:bun apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY --chown=bun:bun packages packages
COPY --chown=bun:bun server.config.json server.config.json
USER bun
EXPOSE 3301
CMD ["bun", "run", "apps/backend/src/server.ts"]
