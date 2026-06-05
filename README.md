# CashLoom

A personal finance tracker — log income & expenses, see analytics, get AI insights, and a monthly email report. Monorepo: a Bun + Express API and a React (Vite) client.

Imported 2026-06-04 from the original 2025-07 contractor build (`arit98/cashloom-{backend,client}`) — secrets stripped, git history dropped — then rebuilt into a tested, deployable app.

## What it does

- **Transactions** — add by hand, scan a receipt (Gemini), import a CSV, or **paste a bank/card statement and let AI parse it** → review → save. Re-imports skip rows you already have (no doubled data).
- **Analytics** — dashboard summary, an income/expense chart bucketed by your timezone, category breakdown, and period-over-period change.
- **Reports** — a monthly email (Resend) with AI insights, also saved and viewable in-app.
- **Auth** — sign up (logs you straight in), sign in, and password reset by email.
- **Settings** — account, display currency, light/dark theme.

## Structure

| Dir | Stack |
|---|---|
| `backend/` | Bun · Express 5 · MongoDB (Mongoose) · TypeScript · Gemini · Resend · Cloudinary |
| `client/`  | React 19 · Vite · shadcn/ui · Redux Toolkit |

## Run

Uses **Bun**. Each app needs its own `.env` (copy the example, fill values; never commit `.env`).

```bash
# backend
cd backend && bun install && cp .env.example .env   # fill values
bun run dev

# client
cd client && bun install && cp .env.example .env
bun run dev
```

Tests: `cd backend && bun run test` — Vitest, including real-DB integration tests (mongodb-memory-server). CI runs typecheck + tests on every push to `main` (`.github/workflows/ci.yml`).

## Deploy

- **Backend** ships as a container — `backend/Dockerfile` (host-agnostic; all secrets are runtime env vars).
- **Client** is a static build — `cd client && bun run build`, then serve `dist/` on any static host.

## Security

⚠️ The original public repos leaked live credentials. **Rotate everything before any deploy** — see [`SECURITY-ROTATION.md`](SECURITY-ROTATION.md). `JWT_SECRET` must be set in production (the app refuses to boot on the default).

## More

- What's built + what's next: [`ROADMAP.md`](ROADMAP.md)
- Compliance / legal notes: [`COMPLIANCE-NOTES.md`](COMPLIANCE-NOTES.md)
