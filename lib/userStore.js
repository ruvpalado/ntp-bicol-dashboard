// Persists individual staff accounts (Name/Surname/Contact Number/Email + password) using Vercel
// Blob storage - same single-JSON-document pattern as awardsStore.js. Small scale (a regional
// program's staff, not a public user base), so one document holding every account is simpler than
// one blob per user and still trivially fast to read/write.
//
// Lifecycle a user record moves through:
//   pending_setup     -> just submitted the Create Account form; has no password yet. A setupToken
//                        was emailed to them.
//   pending_approval  -> set their password via the emailed link; now waiting for an admin to
//                        approve them before they can sign in.
//   active            -> approved; can sign in with email + password.
//   rejected          -> an admin declined the request. Cannot sign in. Kept for the record rather
//                        than deleted, so a rejected request doesn't silently reappear if resubmitted
//                        (see createSignupRequest's re-request handling below).
//   revoked           -> was active, access later withdrawn by an admin. Cannot sign in.
//
// This store only ever holds real individual accounts. The separate shared ADMIN_PASSWORD ("master")
// login in lib/auth.js/api/login.js is untouched by any of this - it keeps working exactly as before,
// specifically so approving the very first account is possible without a chicken-and-egg problem.
const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./auth");

const PATHNAME = "ntp-users/users.json";
const SETUP_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h to click the account-setup email
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h to click a password-reset email

function blobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function getAllUsers() {
  if (blobConfigured()) {
    try {
      const { get } = require("@vercel/blob");
      const result = await get(PATHNAME, { access: "private" });
      if (result && result.statusCode === 200 && result.stream) {
        const text = await new Response(result.stream).text();
        return JSON.parse(text);
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/not\s*found|404|no such/i.test(msg)) {
        console.error("userStore.getAllUsers: Blob read failed:", err);
      }
    }
  }
  return [];
}

async function saveAllUsers(users) {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) " +
        "so accounts can persist without a redeploy - see README."
    );
  }
  const { put } = require("@vercel/blob");
  await put(PATHNAME, JSON.stringify(users), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function findByEmail(email) {
  const users = await getAllUsers();
  const e = normEmail(email);
  return users.find((u) => u.email === e) || null;
}

async function findBySetupToken(token) {
  if (!token) return null;
  const users = await getAllUsers();
  return users.find((u) => u.setupToken && u.setupToken.value === token) || null;
}

async function findByResetToken(token) {
  if (!token) return null;
  const users = await getAllUsers();
  return users.find((u) => u.resetToken && u.resetToken.value === token) || null;
}

/**
 * Creates a pending_setup account request. If the email already has a non-terminal record
 * (pending_setup / pending_approval / active), that existing record is returned unchanged rather
 * than duplicated - active accounts should use "Forgot password" instead, and a still-pending
 * request just gets a fresh setup token so re-requesting after a lost email works. A previously
 * rejected or revoked email is allowed to submit a brand new request (people's circumstances change).
 *
 * @returns {{user: object, isNew: boolean, setupToken: string}}
 */
async function createSignupRequest({ name, surname, contactNumber, email }) {
  const users = await getAllUsers();
  const e = normEmail(email);
  const existing = users.find((u) => u.email === e);
  if (existing && (existing.status === "pending_approval" || existing.status === "active")) {
    return { user: existing, isNew: false, setupToken: null };
  }
  const token = newToken();
  const tokenRecord = { value: token, expiresAt: Date.now() + SETUP_TOKEN_TTL_MS };
  if (existing && existing.status === "pending_setup") {
    existing.name = name; existing.surname = surname; existing.contactNumber = contactNumber;
    existing.setupToken = tokenRecord;
    await saveAllUsers(users);
    return { user: existing, isNew: false, setupToken: token };
  }
  const user = {
    id: crypto.randomBytes(12).toString("hex"),
    email: e,
    name: String(name || "").trim(),
    surname: String(surname || "").trim(),
    contactNumber: String(contactNumber || "").trim(),
    passwordHash: null,
    status: "pending_setup",
    setupToken: tokenRecord,
    resetToken: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    approvedBy: null,
  };
  users.push(user);
  await saveAllUsers(users);
  return { user, isNew: true, setupToken: token };
}

/** Consumes a valid setup token, sets the password, and moves the account to pending_approval. */
async function setPasswordFromSetupToken(token, password) {
  const users = await getAllUsers();
  const user = users.find((u) => u.setupToken && u.setupToken.value === token);
  if (!user) return { ok: false, reason: "invalid" };
  if (user.setupToken.expiresAt < Date.now()) return { ok: false, reason: "expired" };
  user.passwordHash = hashPassword(password);
  user.setupToken = null;
  user.status = "pending_approval";
  await saveAllUsers(users);
  return { ok: true, user };
}

/** Issues a reset token for an ACTIVE account. Silently no-ops for anything else (see forgot-password
 * handler - the response to the user is identical either way, to avoid leaking which emails have
 * accounts). */
async function createResetToken(email) {
  const users = await getAllUsers();
  const e = normEmail(email);
  const user = users.find((u) => u.email === e && u.status === "active");
  if (!user) return null;
  const token = newToken();
  user.resetToken = { value: token, expiresAt: Date.now() + RESET_TOKEN_TTL_MS };
  await saveAllUsers(users);
  return token;
}

async function setPasswordFromResetToken(token, password) {
  const users = await getAllUsers();
  const user = users.find((u) => u.resetToken && u.resetToken.value === token);
  if (!user) return { ok: false, reason: "invalid" };
  if (user.resetToken.expiresAt < Date.now()) return { ok: false, reason: "expired" };
  if (user.status !== "active") return { ok: false, reason: "not_active" };
  user.passwordHash = hashPassword(password);
  user.resetToken = null;
  await saveAllUsers(users);
  return { ok: true, user };
}

async function verifyLogin(email, password) {
  const user = await findByEmail(email);
  if (!user || user.status !== "active" || !user.passwordHash) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

async function approveUser(email, approvedBy) {
  const users = await getAllUsers();
  const e = normEmail(email);
  const user = users.find((u) => u.email === e);
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "pending_approval") return { ok: false, reason: "wrong_status" };
  user.status = "active";
  user.approvedAt = new Date().toISOString();
  user.approvedBy = approvedBy || "master";
  await saveAllUsers(users);
  return { ok: true, user };
}

async function rejectUser(email) {
  const users = await getAllUsers();
  const e = normEmail(email);
  const user = users.find((u) => u.email === e);
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "pending_approval" && user.status !== "pending_setup") return { ok: false, reason: "wrong_status" };
  user.status = "rejected";
  user.setupToken = null;
  await saveAllUsers(users);
  return { ok: true, user };
}

async function revokeUser(email) {
  const users = await getAllUsers();
  const e = normEmail(email);
  const user = users.find((u) => u.email === e);
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "active") return { ok: false, reason: "wrong_status" };
  user.status = "revoked";
  user.resetToken = null;
  await saveAllUsers(users);
  return { ok: true, user };
}

// Strips secrets before a user record leaves the server (admin panel listing, etc).
function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, surname: u.surname, contactNumber: u.contactNumber,
    status: u.status, createdAt: u.createdAt, approvedAt: u.approvedAt, approvedBy: u.approvedBy,
  };
}

module.exports = {
  blobConfigured,
  getAllUsers,
  saveAllUsers,
  findByEmail,
  findBySetupToken,
  findByResetToken,
  createSignupRequest,
  setPasswordFromSetupToken,
  createResetToken,
  setPasswordFromResetToken,
  verifyLogin,
  approveUser,
  rejectUser,
  revokeUser,
  publicUser,
};
