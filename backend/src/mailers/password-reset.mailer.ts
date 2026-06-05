import { sendEmail } from "./mailer";

type ResetEmailParams = {
  email: string;
  username: string;
  resetUrl: string;
  expiresInMinutes: number;
};

// Plain, honest reset email — one clear action, says when the link expires.
export const sendPasswordResetEmail = async ({
  email,
  username,
  resetUrl,
  expiresInMinutes,
}: ResetEmailParams) => {
  const subject = "Reset your CashLoom password";

  const text = `Hi ${username},

We got a request to reset your CashLoom password. Open this link to set a new one:

${resetUrl}

This link expires in ${expiresInMinutes} minutes. If you didn't ask for this, you can ignore this email — your password stays the same.`;

  const html = `
  <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
    <h2 style="font-size: 18px;">Reset your CashLoom password</h2>
    <p>Hi ${username},</p>
    <p>We got a request to reset your password. Click the button to set a new one:</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}"
         style="background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;">
        Set a new password
      </a>
    </p>
    <p style="font-size: 13px; color: #666;">
      This link expires in ${expiresInMinutes} minutes. If you didn't ask for this,
      you can ignore this email — your password stays the same.
    </p>
  </div>`;

  return sendEmail({ to: email, subject, text, html });
};
