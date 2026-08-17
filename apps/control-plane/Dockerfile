FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/control-protocol/package.json packages/control-protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/client/package.json packages/client/package.json
RUN corepack pnpm install --frozen-lockfile \
  --ignore-scripts \
  --filter @opentag/control-plane...
RUN corepack pnpm rebuild esbuild

COPY apps/control-plane apps/control-plane
COPY packages/control-protocol packages/control-protocol
RUN corepack pnpm --filter @opentag/control-protocol build
RUN corepack pnpm --filter @opentag/control-plane build
RUN npm pkg delete devDependencies --prefix apps/control-plane
RUN corepack pnpm --filter @opentag/control-plane \
  deploy --prod --no-optional /output

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace
RUN groupadd --gid 10001 opentag \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin opentag

COPY --from=build --chown=opentag:opentag /output/package.json ./apps/control-plane/package.json
COPY --from=build --chown=opentag:opentag /output/node_modules ./apps/control-plane/node_modules
COPY --from=build --chown=opentag:opentag /workspace/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build --chown=opentag:opentag /workspace/apps/control-plane/migrations ./apps/control-plane/migrations

USER opentag
EXPOSE 3000
CMD ["node", "apps/control-plane/dist/index.js", "serve"]
