// Reproduces (and proves the fix for) a real production error: uploading a province's file fails
// with "No province files have been uploaded yet - nothing to consolidate. The previous dataset is
// still live." even though a valid file was just uploaded, and separately, a deleted province's
// data has been seen lingering on the dashboard.
//
// THE MECHANISM: consolidate() re-reads every slot from Blob storage immediately after the request
// itself just wrote (or deleted) one of them. A cloud object store's get() is not guaranteed to
// see its own request's just-completed put()/del() the instant it returns - if it doesn't, the
// upload consolidates as if the file just saved were never there (this error, verbatim), or a
// delete consolidates the just-deleted file right back in (data that should be gone still showing).
//
// This is impossible to catch with the OTHER test files' in-memory Map blob stub, which is always
// perfectly consistent. This file's stub is deliberately LYING: put()/del() succeed, but the very
// next get() for that same key still returns the pre-write value, exactly modeling a lagging store.
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

// ---------------------------------------------------------------- a Blob store that lags by one read
const REAL = new Map();     // what's actually stored
const STALE_VIEW = new Map(); // what get() answers with - deliberately one write behind
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        // Serve the STALE view: whatever REAL held BEFORE the most recent put()/del() for this key.
        if (!STALE_VIEW.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => STALE_VIEW.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) {
        REAL.set(p, String(b));
        return { url: "memory://" + p };
      },
      async del(p) {
        REAL.delete(p);
        return true;
      },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

/** Catches STALE_VIEW up to REAL for every key - call this to simulate the lag finally clearing. */
function settleStaleReads() {
  STALE_VIEW.clear();
  for (const [k, v] of REAL) STALE_VIEW.set(k, v);
}

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const kpiStore = require(BASE + "lib/kpiStore");

// api/province-upload.js and api/province-data.js now consolidate via the standalone consolidation
// server (see lib/consolidationClient.js) instead of calling lib/consolidate.js in-process. Stub
// global.fetch to run the SAME consolidate()/saveKpi() in-process, against THIS FILE'S deliberately
// lagging Blob stub (STALE_VIEW/REAL, above) - so this test still exercises the exact same read-
// after-write race the consolidation server would face for real, just without a real network call.
process.env.CONSOLIDATION_SERVER_URL = "http://mock-consolidation-server.test";
process.env.CONSOLIDATION_SERVER_TOKEN = "test-consolidation-token";
const { consolidate: __mockConsolidate } = require(BASE + "lib/consolidate");
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  try {
    const consolidation = await __mockConsolidate(null, body.overrides || undefined);
    await kpiStore.saveKpi(consolidation.kpi);
    return {
      status: 200,
      json: async () => ({ ok: true, presentProvinces: consolidation.presentProvinces, missingProvinces: consolidation.missingProvinces }),
    };
  } catch (err) {
    return { status: 200, json: async () => ({ ok: false, code: err.code || null, error: err.message }) };
  }
};

const provinceUpload = require(BASE + "api/province-upload.js");
const provinceData = require(BASE + "api/province-data.js");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);

function provinceFileFromFormat(province, cnrRows) {
  const parsed = template.parseUpload(formatBuffer, "Format.xlsx");
  const out = {};
  for (const [name, grid] of Object.entries(parsed)) out[name] = grid.map((r) => (r ? r.slice() : r));
  const spec = template.findSpec("CNR 2026 ");
  const cnr = out["CNR 2026 "];
  const header = cnr[0].map((c) => (c === null ? "" : String(c).trim()));
  const dateIdx = header.indexOf("Date of Notification");
  const provIdx = header.indexOf("Province");
  const facIdx = header.indexOf("Screening/Diagnosing Health Facility");
  const muniIdx = header.indexOf("City/Municipality");
  const regGroupIdx = header.indexOf("Registration Group");
  const grid = cnr.slice(0, spec.headerRows);
  for (let i = 0; i < cnrRows; i++) {
    const row = new Array(header.length).fill(null);
    row[dateIdx] = "2026-0" + ((i % 9) + 1) + "-15";
    row[provIdx] = province;
    row[muniIdx] = province + " CITY";
    row[facIdx] = province + " HEALTH CENTER";
    if (regGroupIdx !== -1) row[regGroupIdx] = "New";
    grid.push(row);
  }
  out["CNR 2026 "] = grid;
  return out;
}
function toBuffer(parsedSheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, grid] of Object.entries(parsedSheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid.length ? grid : [[]]), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
function mockReq(method, body) {
  return { method, headers: {}, on(event, cb) { if (event === "data" && body) cb(body); if (event === "end") cb(); return this; } };
}
function mockRes() {
  return { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; }, send(o) { this._body = o; return this; }, setHeader() {} };
}
async function uploadProvince(province, buf) {
  const req = mockReq("POST", buf);
  req.url = "/api/province-upload?province=" + encodeURIComponent(province) + "&filename=" + encodeURIComponent(province + ".xlsx") + "&uploadedBy=Tester";
  const res = mockRes();
  await provinceUpload(req, res);
  return res;
}
async function deleteProvince(province) {
  const req = mockReq("DELETE", null);
  req.url = "/api/province-data?province=" + encodeURIComponent(province) + "&uploadedBy=Tester";
  const res = mockRes();
  await provinceData(req, res);
  return res;
}

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(async function run() {
  // ================================================================ 1. upload into a lagging store
  REAL.clear(); STALE_VIEW.clear();
  {
    const r = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 9)));
    check("uploading the FIRST province ever, with the store's reads lagging one write behind, still publishes",
      r._status === 200, JSON.stringify(r._body));
    check("the error this bug produces does not appear",
      !r._body || !r._body.error || !/nothing to consolidate/.test(r._body.error), JSON.stringify(r._body));

    settleStaleReads();
    const { kpi } = await kpiStore.getCurrentKpi();
    check("the published KPI actually reflects the file just uploaded, not an empty region",
      kpi && kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr.notified === 9,
      kpi && JSON.stringify(kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr));
  }

  // ================================================================ 2. a second upload, same lag
  {
    const r = await uploadProvince("MASBATE", toBuffer(provinceFileFromFormat("MASBATE", 6)));
    check("a second province upload also survives the same lag",
      r._status === 200, JSON.stringify(r._body));
    settleStaleReads();
    const { kpi } = await kpiStore.getCurrentKpi();
    check("both areas are present even though the store never actually caught up",
      kpi && kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr.notified === 9 &&
      kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified === 6,
      kpi && JSON.stringify({ albay: kpi.nodes["P|ALBAY"], masbate: kpi.nodes["P|MASBATE"] }));
  }

  // ================================================================ 3. delete into a lagging store
  {
    const r = await deleteProvince("ALBAY");
    check("deleting a province succeeds even with the store's reads lagging", r._status === 200, JSON.stringify(r._body));
    settleStaleReads();
    const { kpi } = await kpiStore.getCurrentKpi();
    check("the deleted province's data is gone from the very next publish, not consolidated back in by the lag",
      kpi && (!kpi.nodes["P|ALBAY"] || kpi.nodes["P|ALBAY"].cnr.notified === 0),
      kpi && kpi.nodes["P|ALBAY"] && JSON.stringify(kpi.nodes["P|ALBAY"].cnr));
    check("MASBATE (untouched by this delete) is still correctly published",
      kpi && kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified === 6);
  }

  // ================================================================ 4. once the lag finally clears, everything still matches
  {
    settleStaleReads();
    settleStaleReads();
    const { kpi } = await kpiStore.getCurrentKpi();
    check("once storage catches up, the published dataset is unchanged (no ALBAY, MASBATE still there)",
      kpi && (!kpi.nodes["P|ALBAY"] || kpi.nodes["P|ALBAY"].cnr.notified === 0) &&
      kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified === 6);
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nSURVIVES A LAGGING BLOB STORE" : "\nRACE CONDITION REPRODUCED");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
