# CashLoom INFO node — the hosted MONEYWORLD door. The builder receives only
# the allowlisted public-read graph from .dockerignore and emits one bundled
# program. The runtime image receives that program plus the two public rights
# documents: no package manifest, node_modules, source tree, tests, demos,
# database, vault, wallet, payment, sender, or connector modules survive.
FROM oven/bun:1-slim AS builder

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

FROM oven/bun:1-slim AS runtime

WORKDIR /app
COPY --from=builder --chown=bun:bun /release/sovereign/src/info-server.js ./sovereign/src/info-server.js
COPY --chown=bun:bun RIGHTS.md rights-adoption.json ./

ENV CASHLOOM_BIND=0.0.0.0
EXPOSE 4747
USER bun
CMD ["bun", "run", "./sovereign/src/info-server.js"]
