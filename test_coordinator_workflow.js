const Module = require("module");
const fs = require("fs");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "master-pw";
process.env.CONSOLIDATION_SERVER_URL = "http://test.local/consolidate";
process.env.CONSOLIDATION_SERVER_TOKEN = "test-token";

const BASE = __dirname + "/";
const BLOB = new Map();
let CONSOLIDATION_FAIL = false;

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
global.fetch = async (url) => {
  if (String(url).includes("/consolidate")) {
    if (CONSOLIDATION_FAIL) {
      return { status: 400, json: async () => ({ ok: false, error: "forced consolidation failure" }) };
    }
    return { status: 200, json: async () => ({ ok: true, presentProvinces: [], missingProvinces: [] }) };
  }
  throw new Error("Unexpected fetch() in test: " + url);
};

const auth = require(BASE + "lib/auth");
const regStore = require(BASE + "lib/coordinatorRegistrationStore");
const reqStore = require(BASE + "lib/coordinatorRequestStore");
const provinceStore = require(BASE + "lib/provinceStore");
const registrationApi = require(BASE + "api/coordinator-registration.js");
const requestApi = require(BASE + "api/coordinator-request.js");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

function mockRes() {
  const res = {
    _status: null, _body: "", _headers: {},
    setHeader(k, v) { this._headers[k] = v; return this; },
    status(c) { this._status = c; return this; },
    json(b) { this._body = JSON.stringify(b); this._json = b; return this; },
    end() { return this; },
  };
  return res;
}
function mockReq({ method, body, cookie } = {}) {
  return {
    method: method || "GET",
    body: body || {},
    query: {},
    headers: Object.assign({ host: "test.example.com" }, cookie ? { cookie } : {}),
  };
}
function sessionCookieFor(identity) {
  return `${auth.SESSION_COOKIE}=${auth.createSessionToken(identity)}`;
}

(async function run() {
  {
    check("registration store starts empty", (await regStore.getAll()).length === 0);
    check("request store starts empty", (await reqStore.getAll()).length === 0);
    const id = regStore.newId();
    check("newId is 24 hex chars", /^[a-f0-9]{24}$/.test(id), id);
    await regStore.saveAll([{ id, province: "Albay", status: "pending" }]);
    const all = await regStore.getAll();
    check("registration store round-trips", all.length === 1 && all[0].id === id, JSON.stringify(all));
    await reqStore.saveAll([{ id: reqStore.newId(), scope: "ALL", status: "pending" }]);
    check("request store round-trips", (await reqStore.getAll()).length === 1);
  }

  {
    const validReg = {
      province: "Albay", facility: "Legazpi City Health Center",
      coordinatorName: "Nurse Ana", role: "Nurse",
      contactNumber: "09171234567", email: "ana@example.com",
    };
    const unauth = mockRes();
    await registrationApi(mockReq({ method: "GET" }), unauth);
    check("registration list requires auth", unauth._status === 401 && unauth._json.ok === false, unauth._body);

    const bad = mockRes();
    await registrationApi(mockReq({ method: "POST", body: Object.assign({}, validReg, { email: "bad" }) }), bad);
    check("bad email rejected", bad._status === 400 && bad._json.ok === false, bad._body);

    const badProv = mockRes();
    await registrationApi(mockReq({ method: "POST", body: Object.assign({}, validReg, { province: "Mars" }) }), badProv);
    check("bad province rejected", badProv._status === 400, badProv._body);

    const ok = mockRes();
    await registrationApi(mockReq({ method: "POST", body: validReg }), ok);
    check("valid registration stored", ok._status === 200 && /^[a-f0-9]{24}$/.test(ok._json.id || ""), ok._body);
    check("stored registration is pending", (await regStore.getAll()).some((x) => x.id === ok._json.id && x.status === "pending"));

    const cookie = sessionCookieFor("master");
    const list = mockRes();
    await registrationApi(mockReq({ method: "GET", cookie }), list);
    check("admin can list registrations", list._status === 200 && list._json.items.some((x) => x.id === ok._json.id));

    const rej = mockRes();
    await registrationApi(mockReq({ method: "POST", cookie, body: { id: ok._json.id, action: "reject" } }), rej);
    check("admin can reject registration", rej._status === 200 && rej._json.item.status === "rejected", rej._body);

    const invalidAction = mockRes();
    await registrationApi(mockReq({ method: "POST", cookie, body: { id: ok._json.id, action: "approve" } }), invalidAction);
    check("approve not wired yet returns 400", invalidAction._status === 400, invalidAction._body);
  }

  {
    const validReq = {
      requesterName: "Dr. Reyes", office: "Regional Office",
      email: "reyes@example.com", scope: "ALBAY", purpose: "Program review",
    };
    const unauth = mockRes();
    await requestApi(mockReq({ method: "GET" }), unauth);
    check("request list requires auth", unauth._status === 401 && unauth._json.ok === false, unauth._body);

    const bad = mockRes();
    await requestApi(mockReq({ method: "POST", body: Object.assign({}, validReq, { purpose: "" }) }), bad);
    check("missing purpose rejected", bad._status === 400, bad._body);

    const ok = mockRes();
    await requestApi(mockReq({ method: "POST", body: validReq }), ok);
    check("valid request stored", ok._status === 200 && /^[a-f0-9]{24}$/.test(ok._json.id || ""), ok._body);

    const cookie = sessionCookieFor("master");
    const fulfill = mockRes();
    await requestApi(mockReq({ method: "POST", cookie, body: { id: ok._json.id, action: "fulfill" } }), fulfill);
    check("admin can fulfill request", fulfill._status === 200 && fulfill._json.item.status === "fulfilled", fulfill._body);
  }

  {
    const key = "NTP_NETWORK";
    const header = ["MUNICIPALITY", "FACILITY", "MHO", "NURSE", "CONTACT NO. (NURSE)", "MEDTECH", "CONTACT NO. (MEDTECH)", "EMAIL ADDRESS (FACILITY)"];
    const entry = {
      slotId: key,
      sheets: { ALBAY: { headerRows: 2, grid: [["header"], header.slice(), ["Legazpi", "Old Facility", "Doc A", "", "", "", "", ""]] } },
      rowCounts: { ALBAY: 1 },
      meta: { filename: "fixture.xlsx", uploadedAt: "2026-01-01T00:00:00.000Z" },
    };
    await provinceStore.saveReferenceEntry(key, entry);

    const submit = mockRes();
    await registrationApi(mockReq({ method: "POST", body: {
      province: "Albay", facility: "New Facility", coordinatorName: "Nurse B", role: "Nurse",
      contactNumber: "09180000000", email: "b@example.com",
    } }), submit);
    const id = submit._json.id;
    const cookie = sessionCookieFor("master");

    const approve = mockRes();
    await registrationApi(mockReq({ method: "POST", cookie, body: { id, action: "approve" } }), approve);
    check("approval returns published", approve._status === 200 && approve._json.published === true, approve._body);
    check("approval targets ALBAY", approve._json.sheet === "ALBAY", approve._body);

    const updated = await provinceStore.getReferenceEntry(key);
    const row = updated.sheets.ALBAY.grid[3];
    check("approval appends exactly one row", updated.sheets.ALBAY.grid.length === 4);
    check("approval maps facility/name/contact/email", row[1] === "New Facility" && row[3] === "Nurse B" && row[4] === "09180000000" && row[7] === "b@example.com", JSON.stringify(row));
    check("approval increments rowCounts", updated.rowCounts.ALBAY === 2);
    check("approval marks submission approved", (await regStore.getAll()).some((x) => x.id === id && x.status === "approved"));

    const beforeMissing = await provinceStore.getReferenceEntry(key);
    const submitCamSur = mockRes();
    await registrationApi(mockReq({ method: "POST", body: {
      province: "Camarines Sur", facility: "Naga Facility", coordinatorName: "MedTech C", role: "MedTech",
      contactNumber: "09190000000", email: "c@example.com",
    } }), submitCamSur);
    const missing = mockRes();
    await registrationApi(mockReq({ method: "POST", cookie, body: { id: submitCamSur._json.id, action: "approve" } }), missing);
    check("missing province sheet rejected", missing._status === 500 && /no CAM SUR sheet/i.test(missing._json.error || ""), missing._body);
    check("missing sheet leaves submission pending", (await regStore.getAll()).some((x) => x.id === submitCamSur._json.id && x.status === "pending"));
    check("missing sheet does not mutate reference", JSON.stringify(await provinceStore.getReferenceEntry(key)) === JSON.stringify(beforeMissing));

    {
    const adminSrc = fs.readFileSync(BASE + "api/admin.js", "utf8");
    check("admin has registration section", adminSrc.includes('id="sec-coordinator-registrations"'));
    check("admin has request section", adminSrc.includes('id="sec-coordinator-requests"'));
    check("admin loads registration API", adminSrc.includes("/api/coordinator-registration"));
    check("admin loads request API", adminSrc.includes("/api/coordinator-request"));
  }

  const beforeRollback = await provinceStore.getReferenceEntry(key);
    const submitFail = mockRes();
    await registrationApi(mockReq({ method: "POST", body: {
      province: "Albay", facility: "Rollback Facility", coordinatorName: "MHO D", role: "MHO",
      contactNumber: "09200000000", email: "d@example.com",
    } }), submitFail);
    CONSOLIDATION_FAIL = true;
    const rolledBack = mockRes();
    await registrationApi(mockReq({ method: "POST", cookie, body: { id: submitFail._json.id, action: "approve" } }), rolledBack);
    CONSOLIDATION_FAIL = false;
    check("consolidation failure returns 500", rolledBack._status === 500, rolledBack._body);
    check("consolidation failure restores reference", JSON.stringify(await provinceStore.getReferenceEntry(key)) === JSON.stringify(beforeRollback));
    check("consolidation failure leaves pending", (await regStore.getAll()).some((x) => x.id === submitFail._json.id && x.status === "pending"));
  }

  {
    const js = fs.readFileSync(BASE + "vendor/dashboard_js_full.txt", "utf8");
    check("public module no longer reads KPI network meta", !js.includes("KPI.meta.ntp_network"));
    check("public module has registration form", js.includes('"/api/coordinator-registration"'));
    check("public module has request form", js.includes('"/api/coordinator-request"'));
    check("public module has ntpSub state", js.includes("ntpSub:"));
  }
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  console.log("\n" + "=".repeat(70));
  results.forEach((r) => console.log((r[1] ? "PASS" : "FAIL") + " - " + r[0] + (r[2] ? "\n         " + r[2] : "")));
  console.log("=".repeat(70) + "\nTOTAL: " + pass + "/" + results.length + " passed\n");
  if (fail.length) { console.log("COORDINATOR ISSUES FOUND"); process.exitCode = 1; }
  else console.log("COORDINATOR SERVICES WORKING");
})();
