/** Public project identifier, read only by an owner session. This is not a
 * wallet credential, a relay-access check, or proof that pairing will succeed. */
export type WalletConnectSetup =
  | { state: "ready"; project_id: string }
  | { state: "not_configured" | "invalid_configuration"; project_id: null };

export function walletConnectSetup(env: { CASHLOOM_WALLETCONNECT_PROJECT_ID?: string } = {
  CASHLOOM_WALLETCONNECT_PROJECT_ID: process.env.CASHLOOM_WALLETCONNECT_PROJECT_ID,
}): WalletConnectSetup {
  const value = env.CASHLOOM_WALLETCONNECT_PROJECT_ID?.trim();
  if (!value) return { state: "not_configured", project_id: null };
  if (!/^[0-9a-f]{32}$/i.test(value)) return { state: "invalid_configuration", project_id: null };
  return { state: "ready", project_id: value };
}
