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

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  console.log("\n" + "=".repeat(70));
  results.forEach((r) => console.log((r[1] ? "PASS" : "FAIL") + " - " + r[0] + (r[2] ? "\n         " + r[2] : "")));
  console.log("=".repeat(70) + "\nTOTAL: " + pass + "/" + results.length + " passed\n");
  if (fail.length) { console.log("COORDINATOR ISSUES FOUND"); process.exitCode = 1; }
  else console.log("COORDINATOR SERVICES WORKING");
})();
