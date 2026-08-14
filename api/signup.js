const userStore = require("../lib/userStore");
const email = require("../lib/email");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2d3a;padding:24px 0;}
  .card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:32px;width:380px;
    box-shadow:0 4px 18px rgba(11,42,74,.08);}
  h1{margin:0 0 4px;font-size:18px;color:var(--navy);}
  p.sub{margin:0 0 20px;font-size:12.5px;color:var(--muted);}
  label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
    letter-spacing:.03em;margin-bottom:6px;}
  input[type=text],input[type=email],input[type=tel]{width:100%;padding:10px 12px;border:1px solid var(--border);
    border-radius:8px;font-size:14px;margin-bottom:16px;}
  button{width:100%;padding:11px;border:none;border-radius:8px;background:var(--navy);color:#fff;
    font-size:13.5px;font-weight:700;cursor:pointer;}
  button:hover{background:#154569;}
  .error{background:#fbe9e7;color:var(--red);border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:16px;}
  .ok{background:#e5f5ec;color:var(--green);border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:16px;}
  .foot{margin-top:16px;font-size:12px;color:var(--muted);text-align:center;}
  .foot a{color:var(--teal);text-decoration:none;font-weight:700;}
  .foot a:hover{text-decoration:underline;}
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function signupFormHtml({ error, values }) {
  values = values || {};
  const v = (k) => String(values[k] || "").replace(/"/g, "&quot;");
  return pageShell({
    title: "Create Account",
    bodyHtml: `
  <form class="card" method="POST" action="/signup">
    <h1>Create Account</h1>
    <p class="sub">Request access to the NTP Bicol Region Dashboard admin panel.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <label for="name">Name</label>
    <input type="text" id="name" name="name" value="${v("name")}" autofocus required>
    <label for="surname">Surname</label>
    <input type="text" id="surname" name="surname" value="${v("surname")}" required>
    <label for="contactNumber">Contact Number</label>
    <input type="tel" id="contactNumber" name="contactNumber" value="${v("contactNumber")}" required>
    <label for="email">Email Address</label>
    <input type="email" id="email" name="email" value="${v("email")}" required>
    <button type="submit">Request Account</button>
    <div class="foot">Already have an account? <a href="/login">Sign in</a></div>
  </form>`,
  });
}

function signupSentHtml() {
  return pageShell({
    title: "Check your email",
    bodyHtml: `
  <div class="card">
    <h1>Check your email</h1>
    <p class="sub">If your request went through, we've sent a link to set your password. After that, an administrator still needs to approve your account before you can sign in.</p>
    <div class="foot"><a href="/login">Back to sign in</a></div>
  </div>`,
  });
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(signupFormHtml({}));
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const surname = String(body.surname || "").trim();
    const contactNumber = String(body.contactNumber || "").trim();
    const requestedEmail = String(body.email || "").trim();

    if (!name || !surname || !contactNumber || !requestedEmail) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(signupFormHtml({ error: "All fields are required.", values: body }));
      return;
    }
    if (!EMAIL_RE.test(requestedEmail)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(signupFormHtml({ error: "Enter a valid email address.", values: body }));
      return;
    }
    if (!userStore.blobConfigured()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(500).send(signupFormHtml({
        error: "Server is missing Blob storage configuration - accounts cannot be saved yet. Contact your administrator.",
        values: body,
      }));
      return;
    }
    if (!email.configured()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(500).send(signupFormHtml({
        error: "Server is missing email configuration (RESEND_API_KEY/MAIL_FROM) - account setup emails cannot be sent yet. Contact your administrator.",
        values: body,
      }));
      return;
    }

    try {
      const result = await userStore.createSignupRequest({
        name, surname, contactNumber, email: requestedEmail,
      });
      // Only actually send an email when a fresh setup token was issued (new request, or a
      // still-pending_setup request re-requesting). An already-active/pending_approval account gets
      // no email here (they should use Forgot Password / just wait for approval instead) - but the
      // page shown to the submitter is identical either way, so this endpoint doesn't reveal account
      // status to whoever is at the keyboard.
      if (result.setupToken) {
        const baseUrl = email.baseUrlFromReq(req);
        await email.sendEmail({
          to: requestedEmail,
          subject: "Set your password - NTP Bicol Region Dashboard",
          html: email.accountSetupEmailHtml({ name, baseUrl, token: result.setupToken }),
        });
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(signupSentHtml());
    } catch (err) {
      console.error("POST /signup failed:", err);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(500).send(signupFormHtml({ error: "Something went wrong: " + err.message, values: body }));
    }
    return;
  }

  res.status(405).send("Method not allowed");
};
