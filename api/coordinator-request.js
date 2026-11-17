const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const store = require("../lib/coordinatorRequestStore");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v, max) {
  return String(v === undefined || v === null ? "" : v).trim().slice(0, max);
}

function validationError(b) {
  if (!clean(b.requesterName, 120)) return "Requester name is required.";
  if (!clean(b.office, 120)) return "Office is required.";
  if (!EMAIL_RE.test(clean(b.email, 160))) return "Enter a valid email address.";
  if (!clean(b.scope, 120)) return "Scope is required.";
  if (!clean(b.purpose, 1000)) return "Purpose is required.";
  return null;
}

function json(res, status, body) {
  return res.status(status).json(body);
}

module.exports = async (req, res) => {
  try {
  const body = req.body || {};

  if (req.method === "POST" && !body.action) {
    const err = validationError(body);
    if (err) return json(res, 400, { ok: false, error: err });
    const item = {
      id: store.newId(),
      requesterName: clean(body.requesterName, 120),
      office: clean(body.office, 120),
      email: clean(body.email, 160),
      scope: clean(body.scope, 120),
      purpose: clean(body.purpose, 1000),
      status: "pending",
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    const all = await store.getAll();
    all.push(item);
    await store.saveAll(all);
    return json(res, 200, { ok: true, id: item.id });
  }

  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: "Unauthorized" });

  if (req.method === "GET") {
    return json(res, 200, { ok: true, items: await store.getAll() });
  }

  if (req.method === "POST") {
    if (!["fulfill", "reject"].includes(body.action)) return json(res, 400, { ok: false, error: "Unknown action." });
    const all = await store.getAll();
    const idx = all.findIndex((x) => x.id === body.id);
    if (idx < 0) return json(res, 400, { ok: false, error: "No request with that id." });
    if (all[idx].status !== "pending") return json(res, 400, { ok: false, error: "That request is no longer pending." });
    all[idx].status = body.action === "fulfill" ? "fulfilled" : "rejected";
    all[idx].decidedAt = new Date().toISOString();
    all[idx].decidedBy = getSessionIdentity(req);
    await store.saveAll(all);
    return json(res, 200, { ok: true, item: all[idx] });
  }

  return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
};
