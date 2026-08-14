// Verifies the exact guarantee requested: "Compute the provincial CNR strictly based on the uploaded
// Excel file. The calculation must remain fixed to the province associated with that file. Uploading
// another Excel file for a different province - even if it contains municipalities/facilities
// belonging to other provinces - must not alter or override the CNR of the original province; each
// dataset must retain its linkage to the province where it was uploaded."
//
// This is already how the pipeline is built, via two mechanisms working together:
//   1. lib/provinceTemplate.js's validateProvinceUpload() stamps every CNR row's Province cell with
//      the slot the file was uploaded to (see "Stamp the Province column from the slot this file was
//      uploaded to" ~line 484), regardless of whatever the source file's own Province column said.
//   2. lib/consolidate.js sets workbook.__trustProvinceColumn = true on the merged workbook, which
//      makes vendor/ntp_pipeline_browser.js's fixProvinceCol()/fixProvinceByMajority() - the
//      facility-name-based re-attribution used elsewhere in the pipeline - into no-ops (see
//      `if (trustProvince) return 0;` at lines 1957 and 2086). Without this, a facility strongly
//      associated with another province (via the built-in FACILITY_PROVINCE_REFERENCE table or the
//      uploaded Facility List roster) would silently drag CNR rows out of the province that actually
//      submitted them.
//
// This test proves the END-TO-END behavior through the real upload API, not just the two mechanisms
// in isolation: uploads a CNR file for CAMARINES SUR whose every row names a facility that the
// built-in reference maps to ALBAY (and whose Province cell literally says "ALBAY" too - the worst
// case), and confirms (a) those rows are still counted under CAMARINES SUR, not moved to ALBAY, and
// (b) ALBAY's own previously-uploaded, unrelated CNR figure is completely untouched by this upload.
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

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
      async del(p) { REAL.delete(p); return true; },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const kpiStore = require(BASE + "lib/kpiStore");

process.env.CONSOLIDATION_SERVER_URL = "http://mock-consolidation-server.test";
process.env.CONSOLIDATION_SERVER_TOKEN = "test-consolidation-token";
const { consolidate: __mockConsolidate } = require(BASE + "lib/consolidate");
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  try {
    const consolidation = await __mockConsolidate(null, body.overrides || undefined);
    await kpiStore.saveKpi(consolidation.kpi);
    return { status: 200, json: async () => ({ ok: true, presentProvinces: consolidation.presentProvinces, missingProvinces: consolidation.missingProvinces }) };
  } catch (err) {
    return { status: 200, json: async () => ({ ok: false, code: err.code || null, error: err.message }) };
  }
};

const provinceUpload = require(BASE + "api/province-upload.js");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);

// Builds a CNR upload for `uploadSlot` whose rows claim to belong to `claimedProvince` in BOTH the
// facility name (a real ALBAY-mapped facility from the pipeline's built-in reference table, when
// claimedProvince is "ALBAY") and the row's own Province cell - the worst-case attempt at a row
// leaking into another area.
function provinceFileWithForeignClaim(uploadSlot, rowCount, claimedProvince, foreignFacility) {
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
  for (let i = 0; i < rowCount; i++) {
    const row = new Array(header.length).fill(null);
    row[dateIdx] = "2026-0" + ((i % 9) + 1) + "-15";
    row[provIdx] = claimedProvince; // the row's OWN claim - should be overridden/ignored
    row[muniIdx] = claimedProvince + " CITY";
    row[facIdx] = foreignFacility || (claimedProvince + " HEALTH CENTER");
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
async function uploadProvince(slot, buf) {
  const req = mockReq("POST", buf);
  req.url = "/api/province-upload?province=" + encodeURIComponent(slot) + "&filename=" + encodeURIComponent(slot + ".xlsx") + "&uploadedBy=Tester";
  const res = mockRes();
  await provinceUpload(req, res);
  return res;
}

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(async function run() {
  REAL.clear();

  // 1. Upload ALBAY's own CNR file: 12 real rows, honestly labelled ALBAY.
  const r1 = await uploadProvince("ALBAY", toBuffer(provinceFileWithForeignClaim("ALBAY", 12, "ALBAY")));
  check("ALBAY's own upload publishes", r1._status === 200, JSON.stringify(r1._body));
  let kpi = (await kpiStore.getCurrentKpi()).kpi;
  const albayBefore = kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr.notified;
  check("ALBAY shows exactly its own 12 rows before any other upload", albayBefore === 12, "got " + albayBefore);

  // 2. Upload CAMARINES SUR's CNR file: 7 rows, EVERY row claiming ALBAY in both its Province cell
  //    AND naming a real ALBAY-mapped facility from the built-in reference table - the worst-case
  //    attempt at a row leaking out of the province it was actually uploaded to.
  const r2 = await uploadProvince(
    "CAMARINES SUR",
    toBuffer(provinceFileWithForeignClaim("CAMARINES SUR", 7, "ALBAY", "BICOL REGIONAL HOSPITAL AND MEDICAL CENTER - MTBN"))
  );
  check("CAMARINES SUR's upload (foreign-claiming rows) publishes", r2._status === 200, JSON.stringify(r2._body));
  kpi = (await kpiStore.getCurrentKpi()).kpi;

  const albayAfter = kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr.notified;
  check("ALBAY's CNR is COMPLETELY UNCHANGED by Camarines Sur's upload - THE CORE GUARANTEE",
    albayAfter === 12, `was 12, now ${albayAfter}`);

  const csNotified = kpi.nodes["P|CAMARINES SUR"] && kpi.nodes["P|CAMARINES SUR"].cnr.notified;
  check("all 7 Camarines Sur rows stayed counted under CAMARINES SUR despite claiming ALBAY",
    csNotified === 7, `expected 7, got ${csNotified}`);

  const regionNotified = kpi.nodes["REGION"] && kpi.nodes["REGION"].cnr.notified;
  check("region total = sum of the two areas exactly (nothing double-counted or vanished)",
    regionNotified === 19, `expected 19, got ${regionNotified}`);

  // 3. Reverse direction: re-upload ALBAY, this time with rows claiming CAMARINES SUR. Confirms the
  //    isolation holds both ways, and that a province's OWN re-upload doesn't leak into a sibling
  //    province's already-published figure either.
  const r3 = await uploadProvince(
    "ALBAY",
    toBuffer(provinceFileWithForeignClaim("ALBAY", 5, "CAMARINES SUR", "CAMARINES SUR HEALTH CENTER"))
  );
  check("ALBAY's re-upload (now claiming Camarines Sur) publishes", r3._status === 200, JSON.stringify(r3._body));
  kpi = (await kpiStore.getCurrentKpi()).kpi;

  const albayFinal = kpi.nodes["P|ALBAY"] && kpi.nodes["P|ALBAY"].cnr.notified;
  check("ALBAY now reflects ONLY its own new 5-row file (fully replaced, not merged with the old 12)",
    albayFinal === 5, `expected 5, got ${albayFinal}`);

  const csFinal = kpi.nodes["P|CAMARINES SUR"] && kpi.nodes["P|CAMARINES SUR"].cnr.notified;
  check("CAMARINES SUR's figure is untouched by ALBAY's re-upload, even though it claims Camarines Sur",
    csFinal === 7, `expected 7 (unchanged), got ${csFinal}`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nEACH PROVINCE'S CNR STAYS LOCKED TO THE FILE IT WAS UPLOADED FROM"
    : "\nCROSS-PROVINCE LEAKAGE DETECTED");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
