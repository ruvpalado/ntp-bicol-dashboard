// Outbound email. Providers resolved automatically at send time, so you can use whichever fits
// without code changes - no npm dependency either way (Resend/Brevo via a plain fetch, SMTP via
// Node's built-in TLS), consistent with this project's dependency-minimal style.
//
// Used for account-setup and password-reset links.
//
// --- Provider 1: Brevo REST API (recommended - works from any server IP) ---
// Delivers to any recipient via a HTTP API call, which (unlike SMTP) is NOT blocked on Vercel's
// shared datacenter IPs. No domain required - you verify any sender email (e.g. your Gmail) once.
//   BREVO_API_KEY - from https://app.brevo.com/settings/keys/api (free tier: 300 emails/day)
//   BREVO_SENDER  - e.g. "NTP Bicol Dashboard <ruvpalado@gmail.com>". Verify this sender once in
//                   Brevo (Settings -> Senders) by clicking the confirmation it emails you.
//
// --- Provider 2: SMTP via Gmail App Password ---
// Lets you send to ANY recipient from a plain gmail.com address - no domain to verify. NOTE: Gmail
// frequently blocks (535) App Password SMTP logins from cloud/shared datacenter IPs like Vercel's,
// so prefer Brevo when deploying to Vercel.
//   SMTP_HOST  - default smtp.gmail.com
//   SMTP_PORT  - default 465 (implicit TLS)
//   SMTP_USER  - e.g. ruvpalado@gmail.com
//   SMTP_PASS  - a 16-char Google App Password (NOT your normal Gmail password)
//   MAIL_FROM  - the from address
//
// --- Provider 3: Resend (fallback) ---
//   RESEND_API_KEY - from https://resend.com
//   MAIL_FROM      - requires a domain verified in Resend, or their shared test sender
//                    ("onboarding@resend.dev") which only delivers to your own verified address.

const tls = require("tls");

// Detected provider, by priority: brevo > smtp > resend. A provider counts as "selected" when its
// own credentials are present (any of them - signalling intent), so missingConfig() can name the
// exact missing var for the provider the operator is clearly setting up.
function providerName() {
  if (process.env.BREVO_API_KEY) return "brevo";
  if (process.env.SMTP_USER || process.env.SMTP_PASS) return "smtp";
  if (process.env.RESEND_API_KEY) return "resend";
  return null;
}

function configured() {
  return missingConfig().length === 0;
}

// Returns the names of the email env vars that are NOT set for the active provider. Empty array when
// fully configured. Lets callers tell the operator the exact variable(s) to fix instead of just
// "not configured" - and lets the startup check in server/index.js fail loudly with specifics.
function missingConfig() {
  const missing = [];
  const provider = providerName();
  if (provider === "brevo") {
    if (!process.env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
    if (!process.env.MAIL_FROM) missing.push("MAIL_FROM");
  } else if (provider === "smtp") {
    if (!process.env.SMTP_USER) missing.push("SMTP_USER");
    if (!process.env.SMTP_PASS) missing.push("SMTP_PASS");
    if (!process.env.MAIL_FROM) missing.push("MAIL_FROM");
  } else if (provider === "resend") {
    if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!process.env.MAIL_FROM) missing.push("MAIL_FROM");
  } else {
    missing.push("BREVO_API_KEY, RESEND_API_KEY, or SMTP_USER+SMTP_PASS");
  }
  return missing;
}

// Fails closed with a clear, specific message rather than silently dropping the email - callers
// (signup/forgot-password handlers) surface this error to the admin/user rather than pretending the
// email went out.
async function sendEmail({ to, subject, html }) {
  const provider = providerName();
  if (provider === "brevo") return sendBrevo({ to, subject, html });
  if (provider === "smtp") return sendSmtp({ to, subject, html });
  return sendResend({ to, subject, html });
}

// ---------------------------------------------------------------- Brevo provider
// POST the transactionally-sent (transactional) email endpoint. Mail is placed in the sender's
// queue; deliverability to the recipient still depends on SPF/DKIM, but the API call itself is
// never blocked by IP the way SMTP AUTH is on shared servers.
async function sendBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM || process.env.BREVO_SENDER;
  if (!apiKey) {
    throw new Error("Server is missing BREVO_API_KEY - set it in the Vercel project's environment variables (see README).");
  }
  if (!from) {
    throw new Error("Server is missing MAIL_FROM (or BREVO_SENDER) - set it in the Vercel project's environment variables (see README).");
  }
  const sender = parseSender(from);
  const toList = (Array.isArray(to) ? to : [to]).map(parseSender);
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: sender.name, email: sender.email },
      to: toList.map((r) => ({ email: r.email, name: r.name })),
      subject,
      htmlContent: html,
      textContent: stripHtml(html),
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
    throw new Error(`Brevo API rejected the email (HTTP ${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------- Resend provider
async function sendResend({ to, subject, html }) {
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

// ---------------------------------------------------------------- SMTP provider (raw TLS)
// A minimal SMTP client over Node's built-in tls, so we need no nodemailer dependency. Implements
// the subset of RFC 5321 needed to send one message: EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA.
async function sendSmtp({ to, subject, html }) {
  const from = process.env.MAIL_FROM;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!from) throw new Error("Server is missing MAIL_FROM - set it in the Vercel project's environment variables (see README).");
  if (!user) throw new Error("Server is missing SMTP_USER - set it in the Vercel project's environment variables (see README).");
  if (!pass) throw new Error("Server is missing SMTP_PASS - set it in the Vercel project's environment variables (see README).");

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "465", 10);

  const fromAddr = extractAddress(from);
  const toAddrs = Array.isArray(to) ? to : [to];

  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    let buffer = "";
    let stage = "greet";         // greet -> ehlo -> auth -> mail -> rcpt -> data
    let authStep = 0;            // 0=login,1=user,2=pass
    let delivered = false;

    const fail = (err) => {
      try { socket.destroy(); } catch (e) { /* ignore */ }
      reject(new Error(`SMTP send failed via ${host}: ${err && err.message ? err.message : String(err)}`));
    };
    const finish = () => {
      delivered = true;
      try { socket.destroy(); } catch (e) { /* ignore */ }
      resolve({ ok: true, provider: "smtp" });
    };

    socket.on("error", (err) => fail(err));
    socket.on("close", () => { if (!delivered) fail(new Error("connection closed before mail was sent")); });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let lineEnd;
      while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        handleLine(line);
      }
    });

    function handleLine(line) {
      // Only final lines (code + space) advance state; multiline bodies (EHLO caps) are skipped.
      if (line.length < 3 || line[3] !== " ") return;
      const code = line.slice(0, 3);

      switch (stage) {
        case "greet":
          // Server's 220 banner - acknowledge and kick off EHLO.
          if (code === "220") { stage = "ehlo"; socket.write("EHLO ntp-bicol-dashboard\r\n"); }
          else fail(new Error("unexpected greeting: " + line));
          break;

        case "ehlo":
          if (code === "250") { stage = "auth"; authStep = 0; socket.write("AUTH LOGIN\r\n"); }
          else fail(new Error("EHLO rejected: " + line));
          break;

        case "auth":
          if (code === "334") {
            if (authStep === 0) { socket.write(`${Buffer.from(user, "utf8").toString("base64")}\r\n`); authStep = 1; }
            else if (authStep === 1) { socket.write(`${Buffer.from(pass, "utf8").toString("base64")}\r\n`); authStep = 2; }
            else fail(new Error("unexpected AUTH LOGIN challenge"));
          } else if (code === "235") {
            stage = "mail";
            socket.write(`MAIL FROM:<${fromAddr}>\r\n`);
          } else {
            fail(new Error(`SMTP authentication failed (${code}) - check SMTP_USER/SMTP_PASS. A Gmail App Password requires 2-Step Verification enabled.`));
          }
          break;

        case "mail":
          if (code === "250") { stage = "rcpt"; socket.write(`RCPT TO:<${toAddrs[0]}>\r\n`); }
          else fail(new Error("MAIL FROM rejected: " + line));
          break;

        case "rcpt":
          if (code === "250" || code === "251") { stage = "data"; socket.write("DATA\r\n"); }
          else fail(new Error(`RCPT TO rejected for ${toAddrs[0]}: ` + line));
          break;

        case "data":
          if (code === "354") {
            socket.write(buildMessage(from, fromAddr, toAddrs, subject, html));
          } else if (code === "250") {
            finish();
          } else {
            fail(new Error("message not accepted: " + line));
          }
          break;
      }
    }

    function buildMessage(from, fromAddr, rcpts, subject, htmlBody) {
      const boundary = "----=_ntp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const lines = [];
      lines.push(`From: ${from}`);
      lines.push(`To: ${rcpts.join(", ")}`);
      lines.push(`Subject: ${subject}`);
      lines.push("MIME-Version: 1.0");
      lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      lines.push("");
      lines.push(`--${boundary}`);
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(stripHtml(htmlBody));
      lines.push(`--${boundary}`);
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(htmlBody);
      lines.push(`--${boundary}--`);
      lines.push(".");
      lines.push("");
      return lines.join("\r\n");
    }
  });
}

function stripHtml(html) {
  // Crude but adequate plain-text counterpart so text-only clients still see the URL.
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ").trim();
}

function extractAddress(from) {
  // "Name <a@b.c>" -> "a@b.c" ; bare "a@b.c" -> itself.
  const m = String(from || "").match(/<([^>]+)>/);
  return m ? m[1].trim() : String(from || "").trim();
}

function parseSender(s) {
  // "Name <a@b.c>" -> { name: "Name", email: "a@b.c" } ; bare "a@b.c" -> { name: null, email: "a@b.c" }.
  const str = String(s || "").trim();
  const m = str.match(/^(.+?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: null, email: str };
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
  missingConfig,
  sendEmail,
  accountSetupEmailHtml,
  passwordResetEmailHtml,
  accountApprovedEmailHtml,
  baseUrlFromReq,
};
