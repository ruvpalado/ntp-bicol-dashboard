// Individual staff accounts: Create Account -> set password via email link -> admin approval ->
// sign in; Forgot Password -> reset via email link -> sign in with the new password; the shared
// master ADMIN_PASSWORD login stays untouched throughout.
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "master-pw";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.MAIL_FROM = "NTP Test <test@example.com>";

const BASE = __dirname + "/";

// ---------------------------------------------------------------- in-memory blob
const BLOB = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!BLOB.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => BLOB.get(p) }, blob: { uploadedAt: "" } };
      },
      async put(p, b) { BLOB.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { BLOB.delete(p); },
    };
  }
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

// ---------------------------------------------------------------- captured "sent" emails
// lib/email.js uses the global fetch() (Resend's REST API) - captured here instead of hitting the
// network. Each entry is the parsed request body Resend would have received.
const SENT_EMAILS = [];
global.fetch = async (url, opts) => {
  if (String(url) === "https://api.resend.com/emails") {
    SENT_EMAILS.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: "test-email-id" }) };
  }
  throw new Error("Unexpected fetch() in test: " + url);
};

const auth = require(BASE + "lib/auth");
const userStore = require(BASE + "lib/userStore");
const login = require(BASE + "api/login.js");
const signup = require(BASE + "api/signup.js");
const resetPassword = require(BASE + "api/reset-password.js");
const forgotPassword = require(BASE + "api/forgot-password.js");
const users = require(BASE + "api/users.js");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

// ---------------------------------------------------------------- mock req/res helpers
function mockRes() {
  const res = {
    _status: null, _body: "", _headers: {},
    setHeader(k, v) { this._headers[k] = v; return this; },
    status(c) { this._status = c; return this; },
    send(b) { this._body = b; return this; },
    json(b) { this._body = JSON.stringify(b); this._json = b; return this; },
    writeHead(c, h) { this._status = c; Object.assign(this._headers, h || {}); return this; },
    end() { return this; },
  };
  return res;
}
function mockReq({ method, body, query, cookie }) {
  return {
    method: method || "GET",
    body: body || {},
    query: query || {},
    headers: Object.assign({ host: "test.example.com" }, cookie ? { cookie } : {}),
  };
}
function sessionCookieFor(identity) {
  return `${auth.SESSION_COOKIE}=${auth.createSessionToken(identity)}`;
}
function extractToken(mailHtml) {
  const m = mailHtml.match(/token=([a-f0-9]+)/);
  return m ? m[1] : null;
}

(async function run() {
  // ================================================================ 1. master password unaffected
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { password: "master-pw", next: "/admin" } }), res);
    check("master password still logs in (unchanged behavior)", res._status === 303 && res._headers.Location === "/admin");
    check("master login sets a session cookie", /ntp_admin_session=/.test(res._headers["Set-Cookie"] || ""));
    const identity = auth.getSessionIdentity({ headers: { cookie: (res._headers["Set-Cookie"] || "").split(";")[0] } });
    check("master session identity is 'master'", identity === "master", identity);
  }
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { password: "wrong", next: "/admin" } }), res);
    check("wrong master password is rejected", res._status === 303 && /error=1/.test(res._headers.Location || ""));
  }

  // ================================================================ 2. Create Account -> set password
  const EMAIL = "jdelacruz@example.gov.ph";
  {
    const res = mockRes();
    await signup(mockReq({ method: "POST", body: {
      name: "Juan", surname: "Dela Cruz", contactNumber: "09171234567", email: EMAIL,
    } }), res);
    check("signup POST returns 200 (confirmation page)", res._status === 200, res._status);
    check("signup sends exactly one email", SENT_EMAILS.length === 1, SENT_EMAILS.length);
    check("signup email addressed to the requester", SENT_EMAILS[0] && SENT_EMAILS[0].to === EMAIL);
  }
  const user = await userStore.findByEmail(EMAIL);
  check("user record created with status pending_setup", !!user && user.status === "pending_setup", user && user.status);
  check("user record carries Name/Surname/Contact/Email", user && user.name === "Juan" && user.surname === "Dela Cruz" && user.contactNumber === "09171234567" && user.email === EMAIL);

  const setupToken = extractToken(SENT_EMAILS[0].html);
  check("setup email contains a usable token", !!setupToken);

  // Login must fail before a password is even set.
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "anything", next: "/admin" } }), res);
    check("login fails before password is set (no passwordHash yet)", /error=1/.test(res._headers.Location || ""));
  }

  // GET the reset-password page with the setup token - should render the set-password form, not an error.
  {
    const res = mockRes();
    await resetPassword(mockReq({ method: "GET", query: { token: setupToken } }), res);
    check("GET /reset-password with a valid setup token renders the form (not 'invalid')", !/Link invalid/.test(res._body));
  }

  // Set the password.
  {
    const res = mockRes();
    await resetPassword(mockReq({ method: "POST", body: { token: setupToken, password: "correcthorse1", confirm: "correcthorse1" } }), res);
    check("setting password from setup token succeeds", res._status === 200 && /Password Set/.test(res._body), res._status);
  }
  const afterSetup = await userStore.findByEmail(EMAIL);
  check("status moves to pending_approval after setting password", afterSetup.status === "pending_approval", afterSetup.status);
  check("setupToken is consumed (cleared) after use", afterSetup.setupToken === null);

  // The same token cannot be reused.
  {
    const res = mockRes();
    await resetPassword(mockReq({ method: "POST", body: { token: setupToken, password: "anotherpass1", confirm: "anotherpass1" } }), res);
    check("a consumed setup token cannot be reused", res._status === 400 && /Link invalid/.test(res._body));
  }

  // Still cannot log in - pending_approval, not active.
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "correcthorse1", next: "/admin" } }), res);
    check("login fails while pending_approval", /error=1/.test(res._headers.Location || ""));
  }

  // ================================================================ 3. Admin approval
  {
    const res = mockRes();
    await users(mockReq({ method: "GET", cookie: sessionCookieFor("master") }), res);
    const list = res._json.users;
    const pending = list.find((u) => u.email === EMAIL);
    check("GET /api/users lists the pending account", !!pending && pending.status === "pending_approval");
    check("GET /api/users never exposes passwordHash", !("passwordHash" in (pending || {})));
  }
  {
    const res = mockRes();
    await users(mockReq({ method: "POST", body: { email: EMAIL, action: "approve" }, cookie: sessionCookieFor("master") }), res);
    check("approve action succeeds", res._status === 200 && res._json.ok === true, JSON.stringify(res._json));
    check("approval notification email sent", SENT_EMAILS.length === 2 && SENT_EMAILS[1].to === EMAIL);
  }
  {
    // Unauthenticated caller cannot approve/reject/revoke.
    const res = mockRes();
    await users(mockReq({ method: "POST", body: { email: EMAIL, action: "revoke" } }), res);
    check("unauthenticated caller is rejected by /api/users", res._status === 401, res._status);
  }
  const approved = await userStore.findByEmail(EMAIL);
  check("status is active after approval", approved.status === "active", approved.status);
  check("approvedBy recorded", approved.approvedBy === "master", approved.approvedBy);

  // Now login works.
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "correcthorse1", next: "/admin" } }), res);
    check("login succeeds once active", res._status === 303 && res._headers.Location === "/admin", res._status);
    const identity = auth.getSessionIdentity({ headers: { cookie: (res._headers["Set-Cookie"] || "").split(";")[0] } });
    check("session identity is the user's email", identity === EMAIL, identity);
  }
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "wrongpassword", next: "/admin" } }), res);
    check("wrong password for an active account is rejected", /error=1/.test(res._headers.Location || ""));
  }

  // ================================================================ 4. Forgot password
  SENT_EMAILS.length = 0;
  {
    const res = mockRes();
    await forgotPassword(mockReq({ method: "POST", body: { email: EMAIL } }), res);
    check("forgot-password sends a reset email for an active account", SENT_EMAILS.length === 1 && SENT_EMAILS[0].to === EMAIL);
  }
  {
    // Same generic response for an email with no account - must not reveal existence either way.
    const res1 = mockRes(); await forgotPassword(mockReq({ method: "POST", body: { email: EMAIL } } ), res1);
    SENT_EMAILS.length = 0;
    const res2 = mockRes(); await forgotPassword(mockReq({ method: "POST", body: { email: "nobody@nowhere.example" } }), res2);
    check("forgot-password gives an identical response for a nonexistent email", res2._status === 200 && res2._body === res1._body);
    check("forgot-password sends no email for a nonexistent account", SENT_EMAILS.length === 0, SENT_EMAILS.length);
  }
  SENT_EMAILS.length = 0;
  const resendRes = mockRes();
  await forgotPassword(mockReq({ method: "POST", body: { email: EMAIL } }), resendRes);
  const resetToken = extractToken(SENT_EMAILS[0].html);
  check("reset email contains a usable token", !!resetToken);

  {
    const res = mockRes();
    await resetPassword(mockReq({ method: "POST", body: { token: resetToken, password: "newpassword2", confirm: "newpassword2" } }), res);
    check("reset via forgot-password token succeeds", res._status === 200 && /Password Reset/.test(res._body), res._status);
  }
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "correcthorse1", next: "/admin" } }), res);
    check("old password no longer works after reset", /error=1/.test(res._headers.Location || ""));
  }
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "newpassword2", next: "/admin" } }), res);
    check("new password works after reset", res._status === 303 && res._headers.Location === "/admin");
  }
  {
    const res = mockRes();
    await resetPassword(mockReq({ method: "POST", body: { token: resetToken, password: "yetanother3", confirm: "yetanother3" } }), res);
    check("a consumed reset token cannot be reused", res._status === 400 && /Link invalid/.test(res._body));
  }

  // ================================================================ 5. Revoke
  {
    const res = mockRes();
    await users(mockReq({ method: "POST", body: { email: EMAIL, action: "revoke" }, cookie: sessionCookieFor("master") }), res);
    check("revoke action succeeds", res._status === 200 && res._json.ok === true);
  }
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL, password: "newpassword2", next: "/admin" } }), res);
    check("revoked account can no longer log in", /error=1/.test(res._headers.Location || ""));
  }

  // ================================================================ 6. Reject
  const EMAIL2 = "reject-me@example.gov.ph";
  await userStore.createSignupRequest({ name: "A", surname: "B", contactNumber: "123", email: EMAIL2 });
  const u2 = await userStore.findByEmail(EMAIL2);
  await userStore.setPasswordFromSetupToken(u2.setupToken.value, "somepassword1");
  {
    const res = mockRes();
    await users(mockReq({ method: "POST", body: { email: EMAIL2, action: "reject" }, cookie: sessionCookieFor("master") }), res);
    check("reject action succeeds", res._status === 200 && res._json.ok === true);
  }
  const rejected = await userStore.findByEmail(EMAIL2);
  check("status is rejected", rejected.status === "rejected", rejected.status);
  {
    const res = mockRes();
    await login(mockReq({ method: "POST", body: { email: EMAIL2, password: "somepassword1", next: "/admin" } }), res);
    check("rejected account cannot log in", /error=1/.test(res._headers.Location || ""));
  }

  // ================================================================ 7. Expired token
  // EMAIL was revoked in section 5, so createResetToken (active-only) won't issue one for it -
  // reactivate a scratch copy just for this check, backdating the token's expiry to exercise the
  // expiry path without waiting an hour for a real one to lapse.
  {
    const all = await userStore.getAllUsers();
    const u = all.find((x) => x.email === EMAIL);
    u.status = "active";
    u.resetToken = { value: "expired-token-fixture", expiresAt: Date.now() - 1000 };
    await userStore.saveAllUsers(all);

    const res = mockRes();
    await resetPassword(mockReq({ method: "POST", body: { token: "expired-token-fixture", password: "irrelevant1", confirm: "irrelevant1" } }), res);
    check("an expired reset token is rejected", res._status === 400 && /expired/i.test(res._body), res._body.slice(0, 120));

    u.status = "revoked"; u.resetToken = null;
    await userStore.saveAllUsers(all);
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  console.log(`\n${"=".repeat(70)}`);
  results.forEach((r) => console.log((r[1] ? "PASS" : "FAIL") + " - " + r[0] + (r[2] ? "\n         " + r[2] : "")));
  console.log(`${"=".repeat(70)}\nTOTAL: ${pass}/${results.length} passed\n`);
  if (fail.length) { console.log("ACCOUNT ISSUES FOUND"); process.exitCode = 1; }
  else console.log("ACCOUNTS WORKING");
})();
