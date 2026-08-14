// Outbound email via Resend's REST API (https://api.resend.com/emails) - a plain fetch call, no SDK
// dependency, consistent with this project's dependency-minimal style (see @vercel/blob and xlsx as
// the only two real dependencies). Used for account-setup and password-reset links.
//
// Required env vars (set in the Vercel project, same as ADMIN_PASSWORD/SESSION_SECRET):
//   RESEND_API_KEY - from https://resend.com (free tier is enough for a staff-sized user base)
//   MAIL_FROM      - the "from" address, e.g. "NTP Bicol Dashboard <noreply@yourdomain.com>".
//                    Resend requires the domain to be verified in their dashboard, OR you can start
//                    with their shared test domain ("onboarding@resend.dev") while verifying your own.

function configured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

// Fails closed with a clear, specific message rather than silently dropping the email - callers
// (signup/forgot-password handlers) surface this error to the admin/user rather than pretending the
// email went out.
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Server is missing RESEND_API_KEY - set it in the Vercel project's environment variables (see README).");
  }
  if (!process.env.MAIL_FROM) {
    throw new Error("Server is missing MAIL_FROM - set it in the Vercel project's environment variables (see README).");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, html }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
    throw new Error(`Resend API rejected the email (HTTP ${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

// baseUrl: e.g. "https://ntp-bicol-dashboard.vercel.app" - derived by the caller from the incoming
// request's own host header, so no extra "what's my public URL" env var is needed.
function accountSetupEmailHtml({ name, baseUrl, token }) {
  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}&mode=setup`;
  return `<div style="font-family:sans-serif;font-size:14px;color:#1f2d3a;">
    <p>Hi ${escapeHtml(name)},</p>
    <p>An account was requested for the NTP Bicol Region Dashboard admin panel. Click below to set your password:</p>
    <p><a href="${link}" style="background:#0b2a4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Set your password</a></p>
    <p>This link expires in 48 hours. After you set a password, an administrator still needs to approve your account before you can sign in.</p>
    <p style="color:#647486;font-size:12px;">If you did not request this, you can ignore this email.</p>
  </div>`;
}

function passwordResetEmailHtml({ name, baseUrl, token }) {
  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}&mode=reset`;
  return `<div style="font-family:sans-serif;font-size:14px;color:#1f2d3a;">
    <p>Hi ${escapeHtml(name)},</p>
    <p>A password reset was requested for your NTP Bicol Region Dashboard account. Click below to choose a new password:</p>
    <p><a href="${link}" style="background:#0b2a4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Reset your password</a></p>
    <p>This link expires in 1 hour. If you did not request this, you can ignore this email - your password will not change.</p>
  </div>`;
}

function accountApprovedEmailHtml({ name, baseUrl }) {
  return `<div style="font-family:sans-serif;font-size:14px;color:#1f2d3a;">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your account for the NTP Bicol Region Dashboard admin panel has been approved. You can now sign in:</p>
    <p><a href="${baseUrl}/login" style="background:#0b2a4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Sign in</a></p>
  </div>`;
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function baseUrlFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

module.exports = {
  configured,
  sendEmail,
  accountSetupEmailHtml,
  passwordResetEmailHtml,
  accountApprovedEmailHtml,
  baseUrlFromReq,
};
