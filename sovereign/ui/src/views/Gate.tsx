import { useState, type FormEvent } from "react";
import { api, errorMessage, setToken } from "../api";
import { WeaveMark } from "../components";
import type { Meta } from "../types";

/** Create or unlock the local vault before any private records are shown. */
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
        setErr("Use at least 8 characters. A longer, unique passphrase is stronger.");
        return;
      }
      if (pass !== pass2) {
        setErr("The passphrases do not match. Check both fields and try again.");
        return;
      }
    } else if (pass.length === 0) {
      setErr("Enter your passphrase to unlock the workspace.");
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
        <p className="gate-tagline">Your money. A clearer way to manage it.</p>

        <form className="gate-card" onSubmit={(e) => void submit(e)}>
          <h2>{creating ? "Create your private workspace" : "Welcome back"}</h2>
          <p className="gate-sub">
            {creating
              ? "Track accounts, record activity and review supported payments from your own local node."
              : "Unlock your local vault to return to your accounts, activity and agreements."}
          </p>

          {creating && (
            <div className="gate-warning">
              <strong>Keep your passphrase somewhere safe.</strong> It encrypts
              signing keys in this node’s vault. Cashloom cannot reset it.
              You need both your saved data and this passphrase to restore a backup.
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
              placeholder={creating ? "Choose a long, unique passphrase" : ""}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? "gate-error" : undefined}
            />
          </label>

          {creating && (
            <label className="field">
              <span className="field-label">Confirm passphrase</span>
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}

          {err && <p id="gate-error" className="form-error" role="alert">{err}</p>}

          <button className="btn btn-primary btn-wide" type="submit" disabled={busy}>
            {busy
              ? creating
                ? "Creating workspace…"
                : "Unlocking…"
              : creating
                ? "Create workspace"
                : "Unlock workspace"}
          </button>
        </form>

        <p className="gate-truths">
          {creating ? "Start with a manual account. Connect services only when you need them." : "Your records and keys stay with your local node."}
          <span className="gate-meta">
            {meta.name} · {meta.mode} · v{meta.version}
          </span>
        </p>
      </div>
    </div>
  );
}
