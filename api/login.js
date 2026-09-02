const { SESSION_COOKIE, SESSION_MAX_AGE_MS, createSessionToken, safeEqual } = require("../lib/auth");
const userStore = require("../lib/userStore");

// Only allow same-site relative redirect targets. The `next` parameter is user-supplied (query
// string / hidden form field), so a bare pass-through would be an open redirect (phishing): after
// login an attacker-supplied ?next=https://evil.com would send the victim there. Accept only a
// single leading "/" that is NOT "//" (protocol-relative) and contains no CR/LF or scheme colon.
function safeRedirectTarget(raw) {
  const v = String(raw || "").trim();
  if (/^\/(?!\/)/.test(v) && !/[\r\n]/.test(v)) return v;
  return "/admin";
}

function loginPageHtml({ error, next }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Login - NTP Bicol Region Dashboard</title>
<style>
  :root{ --navy:#0b2a4a; --teal:#0f7d8c; --red:#c0392b; --border:#dfe5ea; --muted:#647486; }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2d3a;}
  .card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:32px;width:340px;
    box-shadow:0 4px 18px rgba(11,42,74,.08);}
  h1{margin:0 0 4px;font-size:18px;color:var(--navy);}
  p.sub{margin:0 0 20px;font-size:12.5px;color:var(--muted);}
  label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
    letter-spacing:.03em;margin-bottom:6px;}
  input[type=password],input[type=email]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;
    font-size:14px;margin-bottom:16px;}
  .row-head{display:flex;justify-content:space-between;align-items:baseline;}
  .row-head a{font-size:11px;color:var(--teal);text-decoration:none;font-weight:700;}
  .row-head a:hover{text-decoration:underline;}
  button{width:100%;padding:11px;border:none;border-radius:8px;background:var(--navy);color:#fff;
    font-size:13.5px;font-weight:700;cursor:pointer;}
  button:hover{background:#154569;}
  .error{background:#fbe9e7;color:var(--red);border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:16px;}
  .foot{margin-top:16px;font-size:12px;color:var(--muted);text-align:center;}
  .foot a{color:var(--teal);text-decoration:none;font-weight:700;}
  .foot a:hover{text-decoration:underline;}
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>NTP Bicol Region Dashboard</h1>
    <p class="sub">Sign in to update the live data.</p>
    ${error ? '<div class="error">Incorrect email or password.</div>' : ""}
    <label for="email">Email Address</label>
    <input type="email" id="email" name="email" autocomplete="username">
    <div class="row-head">
      <label for="password" style="margin-bottom:0;">Password</label>
      <a href="/forgot-password">Forgot password?</a>
    </div>
    <input type="password" id="password" name="password" style="margin-top:6px;" autofocus required autocomplete="current-password">
    <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
    <button type="submit">Sign In</button>
    <div class="foot">Need access? <a href="/signup">Create an account</a></div>
  </form>
</body>
</html>`;
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const error = req.query.error === "1";
    const next = safeRedirectTarget(typeof req.query.next === "string" ? req.query.next : "/admin");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(loginPageHtml({ error, next }));
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const password = body.password;
    const loginEmail = String(body.email || "").trim();
    const next = safeRedirectTarget(body.next || "/admin");

    if (!process.env.SESSION_SECRET) {
      res.status(500).send("Server is missing SESSION_SECRET - set it in the Vercel project's environment variables.");
      return;
    }

    // The shared master password still works exactly as before, checked first and regardless of
    // whatever (if anything) is in the email field - this is what keeps the very first admin able to
    // sign in and approve individual accounts, with no chicken-and-egg setup problem.
    if (process.env.ADMIN_PASSWORD && safeEqual(password, process.env.ADMIN_PASSWORD)) {
      const token = createSessionToken("master");
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`
      );
      res.writeHead(303, { Location: next });
      res.end();
      return;
    }

    // Individual account login.
    if (loginEmail && password) {
      try {
        const user = await userStore.verifyLogin(loginEmail, password);
        if (user) {
          const token = createSessionToken(user.email);
          res.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`
          );
          res.writeHead(303, { Location: next });
          res.end();
          return;
        }
      } catch (err) {
        console.error("POST /login: account lookup failed:", err);
        // Falls through to the generic incorrect-credentials response below, same as a wrong
        // password - a storage error here should not tell an unauthenticated caller anything more
        // specific than "that didn't work".
      }
    }

    res.writeHead(303, { Location: `/login?error=1&next=${encodeURIComponent(next)}` });
    res.end();
    return;
  }

  res.status(405).send("Method not allowed");
};
