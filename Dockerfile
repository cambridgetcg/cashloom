# CashLoom INFO node — the hosted MONEYWORLD door. Ships ONLY the info
# entrypoint: no vault, no ledger, no senders, no UI in this image. The module
# graph of info-server.ts is the security boundary; the image just honors it.
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
