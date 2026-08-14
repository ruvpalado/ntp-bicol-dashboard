const userStore = require("../lib/userStore");

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
  input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;
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

function formHtml({ token, error, heading, sub }) {
  return pageShell({
    title: "Set Password",
    bodyHtml: `
  <form class="card" method="POST" action="/reset-password">
    <h1>${heading}</h1>
    <p class="sub">${sub}</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <input type="hidden" name="token" value="${String(token).replace(/"/g, "&quot;")}">
    <label for="password">New Password</label>
    <input type="password" id="password" name="password" autofocus required minlength="8">
    <label for="confirm">Confirm Password</label>
    <input type="password" id="confirm" name="confirm" required minlength="8">
    <button type="submit">Set Password</button>
  </form>`,
  });
}

function invalidHtml(reasonText) {
  return pageShell({
    title: "Link Invalid",
    bodyHtml: `
  <div class="card">
    <h1>Link invalid or expired</h1>
    <p class="sub">${reasonText}</p>
    <div class="foot"><a href="/forgot-password">Request a new link</a> &middot; <a href="/login">Back to sign in</a></div>
  </div>`,
  });
}

function doneHtml({ heading, sub, ctaHref, ctaLabel }) {
  return pageShell({
    title: "Password Set",
    bodyHtml: `
  <div class="card">
    <h1>${heading}</h1>
    <p class="sub">${sub}</p>
    <div class="foot"><a href="${ctaHref}">${ctaLabel}</a></div>
  </div>`,
  });
}

async function resolveToken(token) {
  if (!token) return null;
  const setupUser = await userStore.findBySetupToken(token);
  if (setupUser) return { kind: "setup", user: setupUser };
  const resetUser = await userStore.findByResetToken(token);
  if (resetUser) return { kind: "reset", user: resetUser };
  return null;
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const resolved = await resolveToken(token);
    if (!resolved) {
      res.status(200).send(invalidHtml("This link has already been used, or has expired."));
      return;
    }
    const expiry = resolved.kind === "setup" ? resolved.user.setupToken.expiresAt : resolved.user.resetToken.expiresAt;
    if (expiry < Date.now()) {
      res.status(200).send(invalidHtml("This link has expired."));
      return;
    }
    res.status(200).send(formHtml({
      token,
      heading: resolved.kind === "setup" ? "Set Your Password" : "Reset Your Password",
      sub: resolved.kind === "setup"
        ? "Choose a password for your NTP Bicol Region Dashboard account."
        : "Choose a new password for your account.",
    }));
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const token = String(body.token || "");
    const password = String(body.password || "");
    const confirm = String(body.confirm || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    const resolved = await resolveToken(token);
    if (!resolved) {
      res.status(400).send(invalidHtml("This link has already been used, or has expired."));
      return;
    }
    if (password.length < 8) {
      res.status(400).send(formHtml({
        token, error: "Password must be at least 8 characters.",
        heading: resolved.kind === "setup" ? "Set Your Password" : "Reset Your Password",
        sub: "Choose a password for your account.",
      }));
      return;
    }
    if (password !== confirm) {
      res.status(400).send(formHtml({
        token, error: "Passwords do not match.",
        heading: resolved.kind === "setup" ? "Set Your Password" : "Reset Your Password",
        sub: "Choose a password for your account.",
      }));
      return;
    }

    if (resolved.kind === "setup") {
      const result = await userStore.setPasswordFromSetupToken(token, password);
      if (!result.ok) {
        res.status(400).send(invalidHtml(result.reason === "expired" ? "This link has expired." : "This link has already been used, or has expired."));
        return;
      }
      res.status(200).send(doneHtml({
        heading: "Password Set",
        sub: "Your password has been set. An administrator still needs to approve your account before you can sign in - you'll be notified once that happens.",
        ctaHref: "/login", ctaLabel: "Back to sign in",
      }));
    } else {
      const result = await userStore.setPasswordFromResetToken(token, password);
      if (!result.ok) {
        const reasonText = result.reason === "expired" ? "This link has expired."
          : result.reason === "not_active" ? "This account is not active. Contact your administrator."
          : "This link has already been used, or has expired.";
        res.status(400).send(invalidHtml(reasonText));
        return;
      }
      res.status(200).send(doneHtml({
        heading: "Password Reset",
        sub: "Your password has been changed. You can now sign in.",
        ctaHref: "/login", ctaLabel: "Sign in",
      }));
    }
    return;
  }

  res.status(405).send("Method not allowed");
};
