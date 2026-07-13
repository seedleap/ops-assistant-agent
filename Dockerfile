# syntax=docker/dockerfile:1

FROM node:22.19-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM node:22.19-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8010
ENV DATA_DIR=/app/data
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown -R node:node /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node config ./config
COPY --chown=node:node public ./public
COPY --chown=node:node sample-data ./sample-data
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node skills ./skills
USER node
EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8010)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
