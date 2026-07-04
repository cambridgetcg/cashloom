import { useState, type FormEvent } from "react";
import { api, errorMessage, setToken } from "../api";
import { WeaveMark } from "../components";
import type { Meta } from "../types";

/**
 * The front door. Two moods:
 *  - not initialized → forge a passphrase (the passphrase IS custody)
 *  - locked          → unlock
 */
export function Gate({ meta, onEnter }: { meta: Meta; onEnter: () => void }) {
  const creating = !meta.initialized;
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (creating) {
      if (pass.length < 8) {
        setErr("Give it at least 8 characters. This phrase is the only lock there is.");
        return;
      }
      if (pass !== pass2) {
        setErr("The two phrases don't match. Type them again, slowly.");
        return;
      }
    } else if (pass.length === 0) {
      setErr("The vault opens with your passphrase.");
      return;
    }
    setBusy(true);
    try {
      const r = creating ? await api.vaultInit(pass) : await api.vaultUnlock(pass);
      setToken(r.token);
      setPass("");
      setPass2("");
      onEnter();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-inner stagger">
        <WeaveMark size={72} />
        <h1 className="wordmark wordmark-lg">
          Cash<span className="wm-loom">Loom</span>
        </h1>
        <p className="gate-tagline">Everyone pays everyone.</p>

        <form className="gate-card" onSubmit={(e) => void submit(e)}>
          <h2>{creating ? "Forge your passphrase" : "Welcome back"}</h2>
          <p className="gate-sub">
            {creating
              ? "This phrase seals the vault on this machine."
              : "The loom is resting. Unlock it to continue."}
          </p>

          {creating && (
            <div className="gate-warning">
              <strong>Read this once, properly.</strong> Your passphrase is
              custody itself. It encrypts your keys here, on your machine, and
              it never leaves. There is no reset, no recovery, no one to call.
              Write it somewhere real.
            </div>
          )}

          <label className="field">
            <span className="field-label">Passphrase</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoFocus
              autoComplete={creating ? "new-password" : "current-password"}
              placeholder={creating ? "something long, something yours" : ""}
            />
          </label>

          {creating && (
            <label className="field">
              <span className="field-label">Once more</span>
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}

          {err && <p className="form-error">{err}</p>}

          <button className="btn btn-primary btn-wide" type="submit" disabled={busy}>
            {busy
              ? creating
                ? "Forging…"
                : "Unlocking…"
              : creating
                ? "Forge the vault"
                : "Unlock"}
          </button>
        </form>

        <p className="gate-truths">
          Your keys, your data, your machine.
          <span className="gate-meta">
            {meta.name} · {meta.mode} · v{meta.version}
          </span>
        </p>
      </div>
    </div>
  );
}
