# CashLoom API — host-agnostic container. Provide env vars (MONGO_URI, JWT_SECRET,
# GEMINI_API_KEY, CLOUDINARY_*, RESEND_API_KEY, ...) at runtime; none are baked in.

# --- build: install everything, compile TS -> dist ---
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime: prod deps only + compiled output ---
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
EXPOSE 8000
CMD ["bun", "dist/index.js"]
