// Drives the REAL /api/province-upload, /api/province-data (DELETE) and /api/reference-upload
// handlers end-to-end against an in-memory Blob store - same harness as test_province_upload.js
// and test_reference_upload.js, but this file is specifically about what gets PUBLISHED, not just
// what gets stored.
//
// THE RULES under test:
//   1. Deleting an area's file must remove that area's data from the published dashboard.
//   2. If deleting leaves nothing consolidation can produce a dataset from (the only area, or the
//      region's only POPULATION source), the dashboard must stop showing a dataset at all rather
//      than keep showing the one that included the file just deleted.
//   3. Replacing a file (re-uploading the same slot) must make the dashboard reflect the NEW file
//      only - not the old figures, and not old+new merged together.
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

// ---------------------------------------------------------------- in-memory blob + auth stubs
const BLOB = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!BLOB.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => BLOB.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) { BLOB.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { BLOB.delete(p); },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const store = require(BASE + "lib/provinceStore");
const kpiStore = require(BASE + "lib/kpiStore");

// api/province-upload.js, api/province-data.js and api/reference-upload.js now consolidate via the
// standalone consolidation server (see lib/consolidationClient.js) instead of calling
// lib/consolidate.js in-process. Stub global.fetch to run the SAME consolidate()/saveKpi()
// in-process, against this file's own stubbed Blob store - this exercises the real HTTP
// request/response contract consolidationClient.js builds, without needing a real network call.
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
const referenceUpload = require(BASE + "api/reference-upload.js");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

// ---------------------------------------------------------------- fixtures (mirrors test_province_upload.js)
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
    // CNR notified only counts New/Relapse registration groups (per the CNR formula) - without
    // this, every synthetic row here is silently excluded and cnr.notified reads 0 regardless of
    // row count, which would make every check below pass or fail for the wrong reason.
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

// ---------------------------------------------------------------- fake req/res for the handlers
// A plain object rather than a real EventEmitter+process.nextTick: readRawBody() calls
// req.on("data"/"end", cb) at a point that varies (province-upload.js awaits a Blob read for the
// rollback snapshot BEFORE it gets to the body), so a body "emitted" on a timer can fire before
// those listeners are even attached, and the read hangs forever with no error and no output -
// exactly what happened here. Firing synchronously the moment each listener is registered removes
// the race entirely.
function mockReq(method, body) {
  return {
    method,
    headers: {},
    on(event, cb) {
      if (event === "data" && body) cb(body);
      if (event === "end") cb();
      return this;
    },
  };
}
function mockRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(o) { this._body = o; return this; },
    send(o) { this._body = o; return this; },
    setHeader() {},
  };
}
// province-upload.js reads province/filename/uploadedBy from req.url's query string.
async function uploadProvince(province, buf) {
  const req = mockReq("POST", buf);
  req.url = "/api/province-upload?province=" + encodeURIComponent(province) +
    "&filename=" + encodeURIComponent(province + ".xlsx") + "&uploadedBy=Tester";
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
async function uploadReference(slotId, buf) {
  const req = mockReq("POST", buf);
  req.url = "/api/reference-upload?slot=" + encodeURIComponent(slotId) +
    "&filename=" + encodeURIComponent(slotId + ".xlsx") + "&uploadedBy=Tester";
  const res = mockRes();
  await referenceUpload(req, res);
  return res;
}
async function deleteReference(slotId) {
  const req = mockReq("DELETE", null);
  req.url = "/api/reference-upload?slot=" + encodeURIComponent(slotId) + "&uploadedBy=Tester";
  const res = mockRes();
  await referenceUpload(req, res);
  return res;
}

function clearAllStorage() {
  BLOB.clear();
}

(async function run() {
  // ================================================================ 1. delete removes that area's data
  clearAllStorage();
  {
    const r1 = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 10)));
    check("ALBAY upload publishes", r1._status === 200, JSON.stringify(r1._body));

    const r2 = await uploadProvince("MASBATE", toBuffer(provinceFileFromFormat("MASBATE", 7)));
    check("MASBATE upload publishes alongside ALBAY", r2._status === 200, JSON.stringify(r2._body));

    const { kpi: kpiBoth } = await kpiStore.getCurrentKpi();
    check("both areas are present before any delete",
      kpiBoth && kpiBoth.nodes["P|ALBAY"] && kpiBoth.nodes["P|ALBAY"].cnr.notified === 10 &&
      kpiBoth.nodes["P|MASBATE"] && kpiBoth.nodes["P|MASBATE"].cnr.notified === 7,
      kpiBoth && JSON.stringify({ albay: kpiBoth.nodes["P|ALBAY"] && kpiBoth.nodes["P|ALBAY"].cnr.notified,
                                   masbate: kpiBoth.nodes["P|MASBATE"] && kpiBoth.nodes["P|MASBATE"].cnr.notified }));

    const rDel = await deleteProvince("ALBAY");
    check("deleting ALBAY succeeds", rDel._status === 200, JSON.stringify(rDel._body));

    const { kpi: kpiAfter } = await kpiStore.getCurrentKpi();
    check("ALBAY's cases are gone from the region total after deletion",
      kpiAfter && kpiAfter.nodes.REGION.cnr.notified === 7,
      kpiAfter && "region notified = " + kpiAfter.nodes.REGION.cnr.notified);
    check("ALBAY no longer contributes a nonzero node",
      !kpiAfter || !kpiAfter.nodes["P|ALBAY"] || kpiAfter.nodes["P|ALBAY"].cnr.notified === 0,
      kpiAfter && kpiAfter.nodes["P|ALBAY"] && JSON.stringify(kpiAfter.nodes["P|ALBAY"].cnr));
    check("MASBATE is still there, untouched by ALBAY's deletion",
      kpiAfter && kpiAfter.nodes["P|MASBATE"] && kpiAfter.nodes["P|MASBATE"].cnr.notified === 7);
  }

  // ================================================================ 2. deleting the LAST area unpublishes
  clearAllStorage();
  {
    const r1 = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 5)));
    check("(setup) ALBAY-only upload publishes", r1._status === 200, JSON.stringify(r1._body));
    const { kpi: before } = await kpiStore.getCurrentKpi();
    check("(setup) a dataset is published before the delete", !!before);

    const rDel = await deleteProvince("ALBAY");
    check("deleting the only uploaded area succeeds", rDel._status === 200, JSON.stringify(rDel._body));

    const { kpi: after } = await kpiStore.getCurrentKpi();
    check("the dashboard has NO published dataset after its only area is deleted - not the stale one",
      after === null, after && "kpi still present, REGION notified = " + after.nodes.REGION.cnr.notified);

    // Uploading into a fully-empty store (nothing published, every slot empty) must work normally -
    // a prior delete-to-empty must not leave the system in a state where the NEXT upload also fails
    // to consolidate.
    const r2 = await uploadProvince("MASBATE", toBuffer(provinceFileFromFormat("MASBATE", 9)));
    check("a fresh upload after everything was deleted succeeds", r2._status === 200, JSON.stringify(r2._body));
    const { kpi: republished } = await kpiStore.getCurrentKpi();
    check("the dashboard is republished from that upload alone",
      republished && republished.nodes["P|MASBATE"] && republished.nodes["P|MASBATE"].cnr.notified === 9,
      republished && JSON.stringify(republished.nodes["P|MASBATE"] && republished.nodes["P|MASBATE"].cnr));
  }

  // ================================================================ 3. replace reflects the latest upload
  clearAllStorage();
  {
    const r1 = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 10)));
    check("(setup) first ALBAY upload (10 rows) publishes", r1._status === 200, JSON.stringify(r1._body));
    const { kpi: firstKpi } = await kpiStore.getCurrentKpi();
    check("(setup) first upload's figure is 10", firstKpi && firstKpi.nodes["P|ALBAY"].cnr.notified === 10,
      firstKpi && firstKpi.nodes["P|ALBAY"].cnr.notified);

    // Re-upload the SAME slot with different data - this is a replace, not an addition.
    const r2 = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 4)));
    check("replacing ALBAY's file publishes", r2._status === 200, JSON.stringify(r2._body));

    const { kpi: replaced } = await kpiStore.getCurrentKpi();
    check("the dashboard reflects ONLY the replacement file's figure (4), not the old one (10)",
      replaced && replaced.nodes["P|ALBAY"].cnr.notified === 4,
      replaced && "got " + replaced.nodes["P|ALBAY"].cnr.notified);
    check("the replacement did not merge with the old file (would be 14, not 4)",
      replaced && replaced.nodes["P|ALBAY"].cnr.notified !== 14);
  }

  // ================================================================ 4. deleting the sole reference source unpublishes
  clearAllStorage();
  {
    const r1 = await uploadProvince("ALBAY", toBuffer(provinceFileFromFormat("ALBAY", 6)));
    check("(setup) ALBAY upload publishes", r1._status === 200, JSON.stringify(r1._body));

    // Strip ALBAY's own embedded POPULATION so the ONLY population source left is the dedicated
    // reference upload about to be added - mirrors a real setup where population is deliberately
    // maintained as one region-wide reference file instead of duplicated into every province file.
    const entry = await store.getProvinceEntry("ALBAY");
    delete entry.regionalSheets["POPULATION"];
    await store.saveProvinceEntry("ALBAY", entry);

    // Use the real Format.xlsx POPULATION block (not a hand-rolled one) so its forward-filled
    // province/municipality layout parses exactly as the pipeline expects - this test is about
    // publish/unpublish behavior around delete, not about re-proving the population parser.
    const realPop = template.parseUpload(formatBuffer, "Format.xlsx")["POPULATION"];
    const popBuf = toBuffer({ POPULATION: realPop });
    const rRef = await uploadReference("POPULATION", popBuf);
    check("(setup) dedicated POPULATION reference upload publishes", rRef._status === 200, JSON.stringify(rRef._body));
    const { kpi: withRef } = await kpiStore.getCurrentKpi();
    check("(setup) the region-wide reference POPULATION is in use", !!withRef);

    const rDel = await deleteReference("POPULATION");
    check("deleting the sole POPULATION reference succeeds", rDel._status === 200, JSON.stringify(rDel._body));

    const { kpi: after } = await kpiStore.getCurrentKpi();
    check("with no POPULATION source left anywhere, the dashboard has no published dataset",
      after === null, after && "kpi still present");
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nDELETE/REPLACE PUBLISHING IS CORRECT" : "\nPUBLISHING ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
