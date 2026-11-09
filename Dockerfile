ARG BUN_VERSION=1.3.13
ARG CODEX_VERSION=0.166.0
ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM python:3.10-slim-bookworm AS alignment-build
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libespeak-dev \
    && python -m venv /opt/aeneas \
    && /opt/aeneas/bin/pip install --no-cache-dir numpy==1.26.4 setuptools==69.5.1 wheel==0.45.1 \
    && /opt/aeneas/bin/pip install --no-cache-dir --no-build-isolation aeneas==1.7.3.0
RUN /opt/aeneas/bin/pip download --no-deps --no-binary=:all: --dest /opt/aeneas/source aeneas==1.7.3.0 \
    && tar -xOf /opt/aeneas/source/aeneas-1.7.3.0.tar.gz aeneas-1.7.3.0/LICENSE > /opt/aeneas/source/LICENSE

FROM oven/bun:${BUN_VERSION}-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY patches patches
RUN bun install --frozen-lockfile

FROM dependencies AS web-build
COPY apps/web apps/web
COPY packages packages
COPY config/tailwind.config.cjs config/tailwind.config.cjs
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim AS frontend
WORKDIR /app
ENV NODE_ENV=production \
    FRONTEND_PORT=8080
COPY --from=web-build --chown=bun:bun /app/apps/web/dist apps/web/dist
COPY --chown=bun:bun scripts/serve-production-frontend.ts scripts/serve-production-frontend.ts
RUN mkdir -p /var/lib/nous/frontend-assets && chown bun:bun /var/lib/nous/frontend-assets
USER bun
EXPOSE 8080
CMD ["bun", "run", "scripts/serve-production-frontend.ts"]

FROM dependencies AS tooling
COPY apps/backend/src apps/backend/src
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
ARG CODEX_VERSION
USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils espeak ffmpeg \
    && BUN_INSTALL=/usr/local bun add --global "@openai/codex@${CODEX_VERSION}" \
    && mkdir -p /home/bun/.codex /var/lib/nous/icon-index /var/lib/nous/library-exports /var/lib/nous/source-staging \
    && chown bun:bun /home/bun/.codex /var/lib/nous/icon-index /var/lib/nous/library-exports /var/lib/nous/source-staging \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=3301
COPY --from=alignment-build /opt/aeneas /opt/aeneas
COPY --from=alignment-build /usr/local/ /usr/local/
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md
COPY --from=dependencies --chown=bun:bun /app/node_modules node_modules
COPY --chown=bun:bun apps/backend/package.json apps/backend/package.json
COPY --chown=bun:bun apps/backend/src apps/backend/src
COPY --chown=bun:bun apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY --chown=bun:bun packages packages
COPY --chown=bun:bun config/server.config.json config/server.config.json
USER bun
EXPOSE 3301
CMD ["bun", "run", "apps/backend/src/server.ts"]
