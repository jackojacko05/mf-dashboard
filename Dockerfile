FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/pnpm/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/pnpm:$PATH \
    HOME=/tmp

RUN mkdir -p /pnpm \
    && corepack enable \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/crawler/package.json ./apps/crawler/
COPY packages/db/package.json ./packages/db/
COPY packages/date-utils/package.json ./packages/date-utils/
COPY packages/meta/package.json ./packages/meta/
COPY packages/analytics/package.json ./packages/analytics/

RUN package_manager=$(node -p "require('./package.json').packageManager") \
    && corepack prepare "$package_manager" --activate \
    && pnpm install --frozen-lockfile --prod --filter "@mf-dashboard/crawler..." --ignore-scripts \
    && pnpm rebuild --pending --filter "@mf-dashboard/crawler..." \
    && pnpm --filter "@mf-dashboard/crawler" exec playwright install --with-deps chromium \
    && test -x /app/apps/crawler/node_modules/.bin/tsx \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /pnpm/store /var/lib/apt/lists/*

COPY . .

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/apps/crawler/node_modules/.bin/tsx", "/app/apps/crawler/src/cloud-run.ts"]
