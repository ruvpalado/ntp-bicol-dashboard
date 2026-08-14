// Reproduces the exact production bug reported by the user: "still showing data even data is
// deleted in the admin side specially the data of camarines sur."
//
// ROOT CAUSE FOUND: Vercel runtime logs showed lib/provinceStore.js's old deleteJson() - which
// called Blob's del() and then verified with a get() - logging its "still readable immediately
// after delete()" warning REPEATEDLY, for the SAME pathnames (CAMARINES_SUR.json, NAGA_CITY.json,
// CAMARINES_NORTE.json, ALBAY.json), across more than a week. That is not a one-off millisecond-
// scale race (which consolidate.js's `overrides` parameter already protects against, for the one
// request that performs the delete). It means del() was not durably taking effect at all for this
// store: any LATER, UNRELATED request - a different province's own upload or delete - would call
// getAllProvinceEntries() fresh, with no override for the already-"deleted" slot, and read the old
// data straight back, republishing it.
//
// This test models exactly that failure mode: a Blob store whose del() is a permanent no-op (put()
// still works correctly), and proves the tombstone-based delete in provinceStore.js/kpiStore.js
// survives it - i.e. a province stays gone even after a totally unrelated later upload triggers a
// fresh, override-free consolidation.
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

// ---------------------------------------------------------------- a Blob store whose del() never works
const REAL = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!REAL.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => REAL.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) { REAL.set(p, String(b)); return { url: "memory://" + p }; },
      // Models the production failure mode found in the runtime logs: del() reports success but the
      // object is still readable afterward, indefinitely - not just for one immediately-following read.
      async del(p) { return true; },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const kpiStore = require(BASE + "lib/kpiStore");

// api/province-upload.js and api/province-data.js now consolidate via the standalone consolidation
// server (see lib/consolidationClient.js) instead of calling lib/consolidate.js in-process. Stub
// global.fetch to run the SAME consolidate()/saveKpi() in-process, against THIS FILE'S del()-never-
// works Blob stub (REAL, above) - so this test still exercises the exact durability guarantee it's
// named for, just without a real network call.
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
  REAL.clear();

  // Upload two provinces (CAMARINES SUR standing in for the reported case, plus a control).
  {
    const r1 = await uploadProvince("CAMARINES SUR", toBuffer(provinceFileFromFormat("CAMARINES SUR", 9)));
    check("CAMARINES SUR upload publishes", r1._status === 200, JSON.stringify(r1._body));
    const r2 = await uploadProvince("MASBATE", toBuffer(provinceFileFromFormat("MASBATE", 6)));
    check("MASBATE upload publishes", r2._status === 200, JSON.stringify(r2._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    check("both provinces are present before any delete",
      kpi.nodes["P|CAMARINES SUR"] && kpi.nodes["P|CAMARINES SUR"].cnr.notified === 9 &&
      kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified === 6,
      JSON.stringify({ cs: kpi.nodes["P|CAMARINES SUR"], mb: kpi.nodes["P|MASBATE"] }));
  }

  // Delete CAMARINES SUR. The underlying store's del() is a permanent no-op (see the stub above) -
  // this models Vercel Blob's del() not durably taking effect, exactly as seen in production logs.
  {
    const r = await deleteProvince("CAMARINES SUR");
    check("deleting CAMARINES SUR reports success", r._status === 200, JSON.stringify(r._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    check("CAMARINES SUR is gone from the very next (same-request) publish",
      !kpi.nodes["P|CAMARINES SUR"] || kpi.nodes["P|CAMARINES SUR"].cnr.notified === 0,
      kpi.nodes["P|CAMARINES SUR"] && JSON.stringify(kpi.nodes["P|CAMARINES SUR"].cnr));
  }

  // THE ACTUAL BUG: a totally unrelated later action (a different province's own upload) forces a
  // fresh, override-free consolidation that reads every slot straight from the store. Before this
  // fix, CAMARINES SUR's underlying JSON was still sitting in the store (del() never really removed
  // it) and would be read straight back in here, resurrecting it. Uploading SORSOGON has nothing to
  // do with CAMARINES SUR and carries no override for it.
  {
    const r = await uploadProvince("SORSOGON", toBuffer(provinceFileFromFormat("SORSOGON", 4)));
    check("an unrelated SORSOGON upload (no override for CAMARINES SUR) succeeds", r._status === 200, JSON.stringify(r._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    check("CAMARINES SUR stays deleted after an unrelated later consolidation - THE BUG THIS TEST GUARDS AGAINST",
      !kpi.nodes["P|CAMARINES SUR"] || kpi.nodes["P|CAMARINES SUR"].cnr.notified === 0,
      kpi.nodes["P|CAMARINES SUR"] && JSON.stringify(kpi.nodes["P|CAMARINES SUR"].cnr));
    check("MASBATE and the new SORSOGON upload are both still correctly published",
      kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified === 6 &&
      kpi.nodes["P|SORSOGON"] && kpi.nodes["P|SORSOGON"].cnr.notified === 4,
      JSON.stringify({ mb: kpi.nodes["P|MASBATE"], sg: kpi.nodes["P|SORSOGON"] }));
  }

  // And a delete that empties the region entirely must also stay durably empty (kpiStore.clearKpi's
  // matching fix) even though the underlying "current.json" del() is equally unreliable in this model.
  {
    await deleteProvince("MASBATE");
    await deleteProvince("SORSOGON");
    const r = await deleteProvince("CAMARINES SUR"); // already gone, but exercises the delete-of-nothing path
    check("deleting the last remaining provinces still reports success", r._status === 200 || r._status === 400, JSON.stringify(r._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    check("with nothing left uploaded, the dashboard has NO published dataset - not a stale leftover one",
      kpi === null, kpi && JSON.stringify(kpi.meta && kpi.meta.consolidation));
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nDELETES SURVIVE A DEL()-THAT-NEVER-WORKS BLOB STORE" : "\nDELETED DATA RESURFACES - BUG STILL PRESENT");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
