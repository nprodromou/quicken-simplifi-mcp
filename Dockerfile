FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=build /app/dist ./dist
COPY .env.example ./

# Runs as the image's unprivileged `node` user (uid/gid 1000). The cache
# directory is the only path it writes; mount a volume there (or point
# CACHE_DB_PATH elsewhere) to keep tokens and the transaction cache.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
