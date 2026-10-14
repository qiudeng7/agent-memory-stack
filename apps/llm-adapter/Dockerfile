# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /work
ENV CI=true
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/llm-adapter/package.json ./apps/llm-adapter/package.json
RUN pnpm install --frozen-lockfile
COPY apps/llm-adapter ./apps/llm-adapter
COPY scripts/run-tests.mjs ./scripts/run-tests.mjs
RUN pnpm --filter @agent-memory-stack/llm-adapter build
RUN pnpm --filter @agent-memory-stack/llm-adapter deploy --legacy --prod /out

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ENV NODE_ENV=production LLM_BIND=0.0.0.0 LLM_PORT=4010 LLM_PROVIDER=disabled
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /var/lib/ams/oauth && chown node:node /var/lib/ams/oauth && chmod 700 /var/lib/ams/oauth
USER node
EXPOSE 4010
CMD ["node", "dist/src/main.js"]
