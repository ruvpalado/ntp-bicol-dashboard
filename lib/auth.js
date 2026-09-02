// Stateless signed-cookie session for the single admin password - no
// database/session store needed. Plain Node serverless functions (no
// Next.js/Edge middleware), so we can just use node:crypto directly.
const crypto = require("crypto");

const SESSION_COOKIE = "ntp_admin_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is not set.");
  }
  return secret;
}

function hmacHex(message, secret) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// identity: "master" for the shared ADMIN_PASSWORD login, or a user's lowercased email for an
// individual account. Embedded (not just implied) so callers can tell who is signed in - shown in
// the admin header and recorded as the actor on approve/reject/revoke actions.
//
// The identity is hex-encoded, not encodeURIComponent'd: an email address survives
// encodeURIComponent with its dots intact (".gov.ph" etc - encodeURIComponent never escapes ".",
// it's an unreserved character), which collides with the "." delimiters this token format uses and
// corrupts the split() below. Hex output can never contain ".", so it's delimiter-safe regardless of
// what the identity contains. Cookie value as a whole is still standard-safe: parseCookies()
// decodeURIComponent's the full cookie value, which is a no-op here since hex/digits/dots aren't
// touched by that.
function createSessionToken(identity) {
  identity = identity || "master";
  const identityHex = Buffer.from(identity, "utf8").toString("hex");
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${identityHex}.${expiry}`;
  const sig = hmacHex(payload, getSecret());
  return `${payload}.${sig}`;
}

// Returns the identity string on success, or null - never throws (see isAuthenticated's comment).
function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [identityHex, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!expiry || Number.isNaN(expiry) || Date.now() > expiry) return null;
  const payload = `${identityHex}.${expiryStr}`;
  const expectedSig = hmacHex(payload, getSecret());
  // Lengths match (both hex-encoded SHA-256 = 64 chars) so timingSafeEqual is safe here.
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  if (!/^[0-9a-f]*$/i.test(identityHex)) return null;
  return Buffer.from(identityHex, "hex").toString("utf8");
}

// scrypt, not bcrypt: no extra dependency needed (node:crypto is already this file's only import),
// consistent with the rest of the project's dependency-minimal style. 64-byte derived key, random
// 16-byte salt per password, stored as "salt:hash" hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  let hashBuf, testBuf;
  try {
    hashBuf = Buffer.from(hash, "hex");
    testBuf = crypto.scryptSync(String(password), salt, 64);
  } catch (e) {
    return false;
  }
  if (hashBuf.length !== testBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, testBuf);
}

// Constant-time string comparison for secrets that are NOT hashed per-value (e.g. the shared
// ADMIN_PASSWORD and the consolidation server token, which are compared in plaintext). A raw ===
// leaks the comparison length and short-circuits on the first differing byte (a timing side-channel).
// HMAC-ing both sides to equal-length digests first lets timingSafeEqual run safely with no early
// return based on the input lengths.
const SAFE_EQUAL_KEY = "ntp-auth-constanttime-v1";
function safeEqual(a, b) {
  const ha = crypto.createHmac("sha256", SAFE_EQUAL_KEY).update(String(a)).digest();
  const hb = crypto.createHmac("sha256", SAFE_EQUAL_KEY).update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

// Fails CLOSED rather than throwing. verifySessionToken() calls getSecret(), which throws when
// SESSION_SECRET is unset - and every route calls isAuthenticated() before its try/catch, so that
// throw would escape as a bare 500 with no explanation the moment anyone arrived carrying an old
// session cookie. Treating it as "not authenticated" is both safer and clearer: the caller is sent
// to /login, which reports the missing configuration in plain language.
function isAuthenticated(req) {
  return !!getSessionIdentity(req);
}

// "master" (the shared ADMIN_PASSWORD login) or a user's lowercased email, or null if not signed in.
// Same fail-closed behavior as isAuthenticated() above - never throws.
function getSessionIdentity(req) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(cookies[SESSION_COOKIE]);
  } catch (err) {
    console.error("getSessionIdentity: refusing access -", (err && err.message) || err);
    return null;
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  isAuthenticated,
  getSessionIdentity,
  hashPassword,
  verifyPassword,
  safeEqual,
};
