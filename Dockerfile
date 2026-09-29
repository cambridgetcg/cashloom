# CashLoom INFO node — the hosted MONEYWORLD door. The builder receives only
# the allowlisted public-read graph from .dockerignore and emits one bundled
# program. The runtime image receives that program plus the two public rights
# documents: no package manifest, node_modules, source tree, tests, demos,
# database, vault, wallet, payment, sender, or connector modules survive.
# Audited Bun 1.4.2 multiarch index; linux/amd64 passed the 256 MiB release audit.
FROM oven/bun:1-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS builder

WORKDIR /build/sovereign
COPY sovereign/package.json sovereign/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY sovereign/tsconfig.json ./
COPY sovereign/src ./src
RUN mkdir -p /release/sovereign/src \
  && bun build ./src/info-server.ts \
    --target=bun \
    --packages=bundle \
    --production \
    --reject-unresolved \
    --external=supports-color \
    --outfile=/release/sovereign/src/info-server.js

FROM oven/bun:1-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime

WORKDIR /app
COPY --from=builder --chown=bun:bun /release/sovereign/src/info-server.js ./sovereign/src/info-server.js
COPY --chown=bun:bun RIGHTS.md rights-adoption.json ./

ENV CASHLOOM_BIND=0.0.0.0
EXPOSE 4747
USER bun
CMD ["bun", "run", "./sovereign/src/info-server.js"]
