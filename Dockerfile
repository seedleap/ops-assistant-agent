# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.19.0-slim

FROM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=ops-assistant-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM toolchain AS production-dependencies
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=ops-assistant-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="ops-assistant-agent" \
      org.opencontainers.image.description="Loopit creator operations assistant" \
      org.opencontainers.image.revision=$VCS_REF

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8010 \
    STATIC_UI_ENABLED=false \
    DATA_DIR=/app/data \
    SKILLS_DIR=/app/data/skills \
    SYSTEM_PROMPT_FILE=/app/data/config/system-prompt.md \
    SEGMENTS_FILE=/app/data/config/user-segments.json \
    SCHEDULED_TASKS_FILE=/app/data/config/scheduled-tasks.json \
    PUBLIC_DIR=/app/public \
    LOOPIT_DATA_FILE=/app/sample-data/loopit-data.json \
    HOME=/app/data/home \
    XDG_CACHE_HOME=/app/data/cache

WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/seed/config /app/seed/skills \
    && chown -R node:node /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node public ./public
COPY --chown=node:node sample-data ./sample-data
COPY --chown=node:node config ./seed/config
COPY --chown=node:node skills ./seed/skills
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod 0555 /app/docker/entrypoint.sh
USER node
EXPOSE 8010
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8010)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
