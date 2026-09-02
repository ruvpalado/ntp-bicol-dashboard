#!/usr/bin/env node
// Configures outbound email on the linked Vercel project so the account-creation (signup),
// forgot-password and approval-notification emails can be sent.
//
// Three providers are supported by lib/email.js (auto-detected by priority):
//   A) Brevo REST API  - RECOMMENDED: HTTP API call, not blocked on Vercel's IPs, no domain needed.
//   B) SMTP via Gmail App Password - no domain, but Gmail often 535-blocks cloud/datacenter IPs.
//   C) Resend           - needs a domain verified in Resend.
//
// Until one provider is fully configured, the signup / forgot-password / reset-password endpoints
// refuse to send email, and the standalone consolidation server (server/index.js) logs a warning.

const PROVIDERS = {
  BREVO: [
    "BREVO_API_KEY   // from app.brevo.com/settings/keys/api (free: 300 emails/day)",
    "MAIL_FROM       // e.g. \"NTP Bicol Dashboard <ruvpalado@gmail.com>\"",
  ],
  SMTP_GMAIL: [
    "SMTP_USER   // e.g. ruvpalado@gmail.com",
    "SMTP_PASS   // a 16-char Google App Password (needs 2-Step Verification); make it at https://myaccount.google.com/apppasswords",
    "MAIL_FROM   // e.g. \"NTP Bicol Dashboard <ruvpalado@gmail.com>\"",
  ],
  RESEND: [
    "RESEND_API_KEY   // re_... from https://resend.com/api-keys",
    "MAIL_FROM        // must be on a domain verified at https://resend.com/domains (or onboarding@resend.dev, owner-only)",
  ],
};

console.log("Outbound email config for the NTP Bicol Dashboard\n");
console.log("Pick ONE provider. A (Brevo) is recommended: it uses an HTTP API, so it works from\nVercel's shared IPs (unlike Gmail SMTP, which is often 535-blocked), and needs no domain.\n");

for (const [name, vars] of Object.entries(PROVIDERS)) {
  console.log(`--- ${name} ---`);
  vars.forEach((v) => {
    const [cmd, hint] = v.split("//");
    console.log("     vercel env add " + cmd.trim() + "   //" + hint);
  });
  console.log("");
}

console.log("Common:\n");
console.log("     vercel env add MAIL_FROM production   (choose Production)\n");
console.log("Then redeploy so the vars reach production (updates ntp-bicol-dashboard.vercel.app):\n");
console.log("     vercel deploy --prod\n");
console.log("Verify with: vercel env ls production\n");
