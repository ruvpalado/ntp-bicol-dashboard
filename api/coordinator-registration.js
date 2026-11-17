const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const store = require("../lib/coordinatorRegistrationStore");

const PROVINCES = ["Albay", "Camarines Sur", "Camarines Norte", "Catanduanes", "Masbate", "Sorsogon"];
const ROLES = ["MHO", "Nurse", "MedTech"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v, max) {
  return String(v === undefined || v === null ? "" : v).trim().slice(0, max);
}

function validationError(b) {
  if (!PROVINCES.includes(b.province)) return "Select a valid province.";
  if (!clean(b.facility, 120)) return "Facility is required.";
  if (!clean(b.coordinatorName, 120)) return "Coordinator name is required.";
  if (!ROLES.includes(b.role)) return "Select a valid role.";
  if (!clean(b.contactNumber, 40)) return "Contact number is required.";
  if (!EMAIL_RE.test(clean(b.email, 160))) return "Enter a valid email address.";
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
      province: body.province,
      facility: clean(body.facility, 120),
      coordinatorName: clean(body.coordinatorName, 120),
      role: body.role,
      contactNumber: clean(body.contactNumber, 40),
      email: clean(body.email, 160),
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
    if (body.action !== "reject") return json(res, 400, { ok: false, error: "Unknown action." });
    const all = await store.getAll();
    const idx = all.findIndex((x) => x.id === body.id);
    if (idx < 0) return json(res, 400, { ok: false, error: "No registration with that id." });
    if (all[idx].status !== "pending") return json(res, 400, { ok: false, error: "That registration is no longer pending." });
    all[idx].status = "rejected";
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
