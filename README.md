# CashLoom

> **Unified revenue platform** — income/expense tracking, analytics, AI insight, and scheduled reports.

Monorepo. Imported 2026-06-04 from the original 2025-07 contractor build (`arit98/cashloom-{backend,client}`), with all committed secrets stripped and git history dropped. Clean base for active development.

## Structure

| Dir | Stack | Modules |
|---|---|---|
| `backend/` | Express · MongoDB (Mongoose) · TypeScript | auth · user · transaction · analytics (Google Gemini) · report (cron + Resend email) |
| `client/`  | React · Vite · shadcn/ui · Redux Toolkit | dashboard · transactions · reports · settings (account · theme · billing) |

## Setup

Each app needs its own `.env` — copy from the template, fill values. **Never commit `.env`** (it's gitignored).

```bash
# backend
cd backend && npm install && cp .env.example .env   # fill values
npm run dev

# client
cd client && npm install && cp .env.example .env     # fill values
npm run dev
```

## Security

⚠️ The original public repos leaked live credentials. **Rotate everything before any deploy** — see [`SECURITY-ROTATION.md`](SECURITY-ROTATION.md).
