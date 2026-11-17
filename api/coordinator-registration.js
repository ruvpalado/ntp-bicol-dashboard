const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const store = require("../lib/coordinatorRegistrationStore");
const { getReferenceEntry, saveReferenceEntry, appendHistory } = require("../lib/provinceStore");
const { consolidateAndPublish } = require("../lib/consolidationClient");

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

const PROVINCE_SHEETS = {
  Albay: "ALBAY",
  "Camarines Sur": "CAM SUR",
  "Camarines Norte": "CAM NORTE",
  Catanduanes: "CATANDUANES",
  Masbate: "MASBATE",
  Sorsogon: "SORSOGON",
};

function normalizeHeader(v) {
  return String(v === undefined || v === null ? "" : v)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9 ()/&.-]/g, "")
    .trim();
}

function findColumn(header, names) {
  const normalized = header.map(normalizeHeader);
  for (const name of names) {
    const idx = normalized.indexOf(normalizeHeader(name));
    if (idx >= 0) return idx;
  }
  return -1;
}

function appendCoordinatorRow(previous, item) {
  const sheetKey = PROVINCE_SHEETS[item.province];
  const sheet = sheetKey && previous.sheets && previous.sheets[sheetKey];
  if (!sheet || !Array.isArray(sheet.grid) || !sheet.grid.length) {
    throw new Error("NTP Network reference has no " + sheetKey + " sheet. Upload it in Admin → Regional Reference Data first.");
  }
  const header = sheet.grid[Math.max(0, (sheet.headerRows || 2) - 1)] || [];
  const row = new Array(header.length).fill("");
  const setCell = (names, value) => {
    const idx = findColumn(header, names);
    if (idx >= 0) row[idx] = value;
  };
  setCell(["FACILITY"], item.facility);
  if (item.role === "MHO") setCell(["MHO"], item.coordinatorName);
  if (item.role === "Nurse") setCell(["NURSE"], item.coordinatorName);
  if (item.role === "MedTech") setCell(["MEDTECH"], item.coordinatorName);
  if (item.role === "Nurse") setCell(["CONTACT NO. (NURSE)"], item.contactNumber);
  if (item.role === "MedTech") setCell(["CONTACT NO. (MEDTECH)"], item.contactNumber);
  setCell(["EMAIL ADDRESS (FACILITY)"], item.email);

  const next = JSON.parse(JSON.stringify(previous));
  next.sheets[sheetKey].grid.push(row);
  next.rowCounts = Object.assign({}, previous.rowCounts || {});
  next.rowCounts[sheetKey] = (next.rowCounts[sheetKey] || 0) + 1;
  next.meta = Object.assign({}, previous.meta || {}, { updatedAt: new Date().toISOString() });
  return { sheetKey, entry: next };
}

async function approveRegistration(item, actor) {
  const previous = await getReferenceEntry("NTP_NETWORK");
  if (!previous) throw new Error("NTP Network reference data has not been uploaded. Upload it in Admin → Regional Reference Data first.");
  const { sheetKey, entry } = appendCoordinatorRow(previous, item);
  await saveReferenceEntry("NTP_NETWORK", entry);
  try {
    await consolidateAndPublish({ reference: { NTP_NETWORK: entry } });
  } catch (err) {
    try {
      await saveReferenceEntry("NTP_NETWORK", previous);
    } catch (rbErr) {
      console.error("coordinator approval rollback failed:", rbErr);
    }
    await appendHistory({
      action: "coordinator-approval-rollback", target: "NTP Network", uploadedBy: actor,
      filename: item.facility, ok: false, message: err.message,
    });
    throw err;
  }
  await appendHistory({
    action: "coordinator-approval", target: "NTP Network", uploadedBy: actor,
    filename: item.facility, ok: true, message: "Approved " + item.coordinatorName + " into " + sheetKey + ".",
  });
  return sheetKey;
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
    const all = await store.getAll();
    const idx = all.findIndex((x) => x.id === body.id);
    if (idx < 0) return json(res, 400, { ok: false, error: "No registration with that id." });
    if (all[idx].status !== "pending") return json(res, 400, { ok: false, error: "That registration is no longer pending." });

    if (body.action === "reject") {
      all[idx].status = "rejected";
      all[idx].decidedAt = new Date().toISOString();
      all[idx].decidedBy = getSessionIdentity(req);
      await store.saveAll(all);
      return json(res, 200, { ok: true, item: all[idx] });
    }

    if (body.action === "approve") {
      const actor = getSessionIdentity(req);
      try {
        const sheet = await approveRegistration(all[idx], actor);
        all[idx].status = "approved";
        all[idx].decidedAt = new Date().toISOString();
        all[idx].decidedBy = actor;
        await store.saveAll(all);
        return json(res, 200, { ok: true, item: all[idx], published: true, sheet });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    return json(res, 400, { ok: false, error: "Unknown action." });
  }

  return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
};
