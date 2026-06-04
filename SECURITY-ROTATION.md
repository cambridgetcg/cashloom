# 🔑 Secret rotation checklist — DO THIS FIRST

The original code was published in **public** repos (`arit98/cashloom-backend`, `arit98/cashloom-client`) with `.env` **committed**. These credentials are readable by anyone on GitHub and must be treated as **permanently compromised** (they're in git history, and may be forked/cached/indexed — deleting the repo does NOT undo this).

**Important:** those repos belong to the *contractor's* account, not yours — so you can't make them private or delete them. **Rotation is the only real fix.** (You can ask the contractor to delete them too, but rotation is what actually closes the hole.)

## Rotate these four — each invalidates the leaked value

- [ ] **MongoDB (`MONGO_URI`)** — Atlas → *Database Access* → edit the DB user → **reset password** (or delete + recreate the user). Then: *Network Access* → confirm IP allowlist isn't `0.0.0.0/0`; check for unfamiliar entries. **Audit the data** for tampering — the whole DB was reachable.
- [ ] **Google Gemini (`GEMINI_API_KEY`)** — Google AI Studio / Cloud Console → **delete the leaked key**, create a new one. Check billing for unexpected usage.
- [ ] **Cloudinary (`CLOUDINARY_API_SECRET`)** — Console → *Settings → Security* → **regenerate API secret**. (`CLOUDINARY_API_KEY` + cloud name are fine to keep; the *secret* is the sensitive one.)
- [ ] **Resend (`RESEND_API_KEY`)** — Dashboard → *API Keys* → **revoke** the leaked key, create a new one. Check sending logs for abuse.

## After rotating

- [ ] Put the **new** values only in `backend/.env` here (gitignored — never committed).
- [ ] (Optional) Ask the contractor to delete/privatize `arit98/cashloom-*`.
- [ ] Decide the canonical home for this repo (your own private repo) and push there.

*Once these are done, the leak is closed and development can proceed on safe ground.*
