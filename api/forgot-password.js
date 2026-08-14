const userStore = require("../lib/userStore");
const email = require("../lib/email");

function pageShell({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - NTP Bicol Region Dashboard</title>
<style>
  :root{ --navy:#0b2a4a; --teal:#0f7d8c; --red:#c0392b; --green:#2e8b57; --border:#dfe5ea; --muted:#647486; }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2d3a;}
  .card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:32px;width:340px;
    box-shadow:0 4px 18px rgba(11,42,74,.08);}
  h1{margin:0 0 4px;font-size:18px;color:var(--navy);}
  p.sub{margin:0 0 20px;font-size:12.5px;color:var(--muted);}
  label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
    letter-spacing:.03em;margin-bottom:6px;}
  input[type=email]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;
    font-size:14px;margin-bottom:16px;}
  button{width:100%;padding:11px;border:none;border-radius:8px;background:var(--navy);color:#fff;
    font-size:13.5px;font-weight:700;cursor:pointer;}
  button:hover{background:#154569;}
  .error{background:#fbe9e7;color:var(--red);border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:16px;}
  .foot{margin-top:16px;font-size:12px;color:var(--muted);text-align:center;}
  .foot a{color:var(--teal);text-decoration:none;font-weight:700;}
  .foot a:hover{text-decoration:underline;}
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function formHtml({ error }) {
  return pageShell({
    title: "Forgot Password",
    bodyHtml: `
  <form class="card" method="POST" action="/forgot-password">
    <h1>Forgot Password</h1>
    <p class="sub">Enter your account email and we'll send you a link to reset your password.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <label for="email">Email Address</label>
    <input type="email" id="email" name="email" autofocus required>
    <button type="submit">Send Reset Link</button>
    <div class="foot"><a href="/login">Back to sign in</a></div>
  </form>`,
  });
}

function sentHtml() {
  return pageShell({
    title: "Check your email",
    bodyHtml: `
  <div class="card">
    <h1>Check your email</h1>
    <p class="sub">If that email has an active account, a password reset link is on its way. The link expires in 1 hour.</p>
    <div class="foot"><a href="/login">Back to sign in</a></div>
  </div>`,
  });
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(formHtml({}));
    return;
  }

  if (req.method === "POST") {
    const requestedEmail = String((req.body || {}).email || "").trim();
    // Always the same response regardless of what happens below - this endpoint must not reveal
    // whether an email has an account (or its status) to whoever is submitting the form.
    const respondSent = () => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(sentHtml());
    };
    if (!requestedEmail) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(formHtml({ error: "Enter your email address." }));
      return;
    }
    try {
      const token = await userStore.createResetToken(requestedEmail);
      if (token && email.configured()) {
        const user = await userStore.findByEmail(requestedEmail);
        const baseUrl = email.baseUrlFromReq(req);
        await email.sendEmail({
          to: requestedEmail,
          subject: "Reset your password - NTP Bicol Region Dashboard",
          html: email.passwordResetEmailHtml({ name: user.name, baseUrl, token }),
        });
      }
    } catch (err) {
      // Logged, but still not surfaced to the caller - same reasoning as above.
      console.error("POST /forgot-password: could not send reset email:", err);
    }
    respondSent();
    return;
  }

  res.status(405).send("Method not allowed");
};
