/**
 * Said once, calmly, before money leaves. The only senders are Bitcoin and
 * Base, and a confirmed payment on either is final. Someone else's hurry,
 * secrecy or borrowed authority is the usual shape of a payment scam, and the
 * defence is a check you start yourself. No countdown, no alarm colour.
 */
export function PaymentFinalNote() {
  return (
    <p className="pay-final-note">
      A sent payment can't be recalled. If someone asked you to send this — in a hurry, in secret,
      or in the name of a company or authority — check with them first through a channel you find
      yourself.
    </p>
  );
}
