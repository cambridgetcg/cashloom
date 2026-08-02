# CashLoom INFO node — the hosted MONEYWORLD door. Runs ONLY the info
# entrypoint. The source image also contains shared modules, so the audited
# module graph of info-server.ts—not artifact minimization—is the boundary.
FROM oven/bun:1-slim
WORKDIR /app

COPY sovereign/package.json sovereign/bun.lock ./sovereign/
RUN cd sovereign && bun install --frozen-lockfile --production

COPY sovereign/src ./sovereign/src
COPY RIGHTS.md rights-adoption.json ./

WORKDIR /app/sovereign
ENV CASHLOOM_BIND=0.0.0.0
EXPOSE 4747
CMD ["bun", "run", "src/info-server.ts"]
