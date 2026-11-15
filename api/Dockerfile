# One image, three roles, chosen at deploy time:
#   API      WORKERS_ENABLED=false  node dist/main
#   worker   WORKERS_ENABLED=true   node dist/main
#   migrate  npm run migration:run:prod (a one-off job before each release)
# It runs with NODE_ENV=production, which doesn't boot without
# TRUST_PROXY_HOPS: how many proxies in front of the API set X-Forwarded-For
# (0 for none).

# ---- build: full dependencies, compile TypeScript
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: compiled code and production dependencies only
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Never run as root inside the container.
USER node
EXPOSE 3000
# node directly, not npm: signals (SIGTERM on deploy) reach the app, which
# then finishes in-flight work before exiting (enableShutdownHooks).
CMD ["node", "dist/main"]
