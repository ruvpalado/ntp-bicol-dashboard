// Verifies the "System Scheduling" requirement end-to-end, PER AREA (not a single shared date):
//   - Configure the Awardee & Recognition module to be event-driven.
//   - Set trigger: "On DQC commencement date/time" - independently for each of the 6 provinces
//     plus Naga City.
//   - Ensure synchronization with the DQC calendar.
//
// Implemented as: the admin sets an activation date/time for ONE area at a time
// (lib/awardsStore.js's getActivationDates/setActivationDate, a flat { "<AREA>": "<iso>" } map,
// exposed via POST /api/awards {setActivation:{area,value}}). Before that area's own moment, the
// public dashboard shows a "Coming Soon" placeholder for Awardee Recognition on THAT area's page
// only; other areas are unaffected. Per explicit product decision: an area with NO date configured
// stays always-visible, regardless of whether other areas have dates set - there is no "whole
// deployment" fallback flag, each area's visibility depends only on its own entry (or lack of one)
// in the map. The region-wide view activates once every area that DOES have a date has passed it;
// areas with no date at all never hold the region view back.
//
// Part A (fast, no browser) exercises the storage layer and the two server endpoints directly.
// Part B boots the REAL gating functions (extracted verbatim from vendor/dashboard_js_full.txt) in
// an isolated vm sandbox and drives them through several area/date combinations.
const Module = require("module");
const fs = require("fs");

process.env.SESSION_SECRET = "test-secret";
process.env.BLOB_READ_WRITE_TOKEN = "test-token";

const STORE = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!STORE.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => STORE.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) { STORE.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { STORE.delete(p); return true; },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const awardsStore = require(BASE + "lib/awardsStore");
const awardsHandler = require(BASE + "api/awards.js");
const { buildDashboardHtml } = require(BASE + "lib/buildDashboardHtml");
const { PROVINCE_SLOTS } = require(BASE + "lib/provinceTemplate");
const template = require(BASE + "lib/provinceTemplate");
const { runPipelineOnWorkbook } = require(BASE + "lib/pipeline");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

function mockReq(method, jsonBody) {
  const body = jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : null;
  return { method, headers: {}, on(e, cb) { if (e === "data" && body) cb(body); if (e === "end") cb(); return this; } };
}
function mockRes() {
  return { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; }, send(o) { this._body = o; return this; }, setHeader() {} };
}

// A real, small, pipeline-computed KPI (POPULATION + one province's worth of case-free data) - a
// proven-valid shape, safe to actually execute pipeline-adjacent code against.
const formatBuf = fs.readFileSync(BASE + "test_fixtures_Format.xlsx");
const populationGrid = template.parseUpload(formatBuf, "Format.xlsx")["POPULATION"];
const kpi = runPipelineOnWorkbook({ SheetNames: ["POPULATION"], Sheets: { POPULATION: populationGrid } });

(async function run() {
  // ---------------------------------------------------------------------------- Part A: server side
  STORE.clear();
  {
    const before = await awardsStore.getActivationDates();
    check("no activation configured initially -> {}", before && Object.keys(before).length === 0, JSON.stringify(before));
  }
  {
    const req = mockReq("GET"); const res = mockRes();
    await awardsHandler(req, res);
    check("GET /api/awards returns activation:{} before anything is configured",
      res._body && res._body.activation && Object.keys(res._body.activation).length === 0, JSON.stringify(res._body));
  }
  {
    const req = mockReq("POST", { setActivation: { area: "unknown-area", value: "2026-09-01T08:30" } });
    const res = mockRes();
    await awardsHandler(req, res);
    check("POST setActivation rejects an unknown area", res._status === 400, JSON.stringify(res._body));
  }
  {
    const req = mockReq("POST", { setActivation: { area: "albay", value: "2026-09-01T08:30" } });
    const res = mockRes();
    await awardsHandler(req, res);
    check("POST setActivation succeeds for one area (lower-case accepted, normalized)",
      res._status === 200 && res._body.ok === true, JSON.stringify(res._body));
    check("response echoes only that area set, others absent",
      res._body.activation["ALBAY"] === "2026-09-01T08:30" && !("CATANDUANES" in res._body.activation),
      JSON.stringify(res._body));
  }
  {
    const stored = await awardsStore.getActivationDates();
    check("getActivationDates reads back exactly what was saved for that one area",
      stored["ALBAY"] === "2026-09-01T08:30" && Object.keys(stored).length === 1, JSON.stringify(stored));
  }
  {
    // Set a second, different area/date - must not disturb the first.
    const req = mockReq("POST", { setActivation: { area: "CATANDUANES", value: "2026-10-15T09:00" } });
    const res = mockRes();
    await awardsHandler(req, res);
    const stored = await awardsStore.getActivationDates();
    check("setting a second area leaves the first area's date untouched",
      stored["ALBAY"] === "2026-09-01T08:30" && stored["CATANDUANES"] === "2026-10-15T09:00", JSON.stringify(stored));
  }
  {
    const req = mockReq("POST", { setActivation: { area: "ALBAY", value: null } });
    const res = mockRes();
    await awardsHandler(req, res);
    const stored = await awardsStore.getActivationDates();
    check("clearing ALBAY removes only that key, CATANDUANES stays",
      !("ALBAY" in stored) && stored["CATANDUANES"] === "2026-10-15T09:00", JSON.stringify(stored));
  }
  {
    // Clean up for Part B's own fixtures.
    await awardsStore.setActivationDate("CATANDUANES", null);
  }

  // buildDashboardHtml embeds the per-area map as-is (no expansion) - verify only the configured
  // area(s) appear, not every area.
  {
    const html = buildDashboardHtml(kpi, {}, { "ALBAY": "2026-09-01T08:30" });
    const embedded = html.match(/let NTP_AWARD_ACTIVATION = (\{[^;]*\});/);
    check("built page embeds NTP_AWARD_ACTIVATION", !!embedded, "not found in output");
    if (embedded) {
      const parsed = JSON.parse(embedded[1]);
      check("only the one configured area is present in the embedded map",
        parsed["ALBAY"] === "2026-09-01T08:30" && Object.keys(parsed).length === 1, JSON.stringify(parsed));
    }
  }

  // ---------------------------------------------------------- Part B: the real client gating logic
  // Runs the ACTUAL gating functions from vendor/dashboard_js_full.txt (extracted verbatim, not
  // reimplemented) in an isolated vm sandbox with just their real free variables (NTP_AWARD_ACTIVATION,
  // ALLP, state, LABEL) pre-set - proving the exact shipped logic without booting the whole ~1.2MB
  // dashboard bundle in jsdom.
  const vm = require("vm");
  const dashboardSrc = fs.readFileSync(BASE + "vendor/dashboard_js_full.txt", "utf8");
  const gatingMatch = dashboardSrc.match(
    /function areaActivationDate\(area\)\{[\s\S]*?function isAwardsActiveForCurrentPage\(\)\{[\s\S]*?\n\}/
  );
  check("the gating functions are still present verbatim in the shipped source (extraction didn't silently match nothing)",
    !!gatingMatch, "regex found no match - the source likely changed shape");

  function evalGating(activationObj, page) {
    const sandbox = { NTP_AWARD_ACTIVATION: activationObj, ALLP: kpi.meta.all_provinces, state: { page } };
    vm.createContext(sandbox);
    vm.runInContext(gatingMatch[0] + "\nresult = isAwardsActiveForCurrentPage();", sandbox);
    return sandbox.result;
  }

  {
    const active = evalGating({}, "REGION");
    check("never configured ({}) -> active for REGION", active === true, String(active));
  }
  {
    const active = evalGating({}, "ALBAY");
    check("never configured ({}) -> active for a province page too", active === true, String(active));
  }
  {
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 16);
    check("ALBAY has a future date -> NOT active for ALBAY specifically",
      evalGating({ ALBAY: future }, "ALBAY") === false, future);
    check("ALBAY has a future date, but SORSOGON (unconfigured) is still active on its own page",
      evalGating({ ALBAY: future }, "SORSOGON") === true, future);
    check("ALBAY has a future date -> REGION is NOT active (one configured-but-pending area blocks it)",
      evalGating({ ALBAY: future }, "REGION") === false, future);
  }
  {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 16);
    check("ALBAY has a past date -> active for ALBAY",
      evalGating({ ALBAY: past }, "ALBAY") === true, past);
    check("ALBAY has a past date and every OTHER area is unconfigured -> REGION is active " +
      "(unconfigured areas never hold the region view back)",
      evalGating({ ALBAY: past }, "REGION") === true, past);
  }
  {
    // Mixed: some areas configured-and-past, one configured-and-future, rest unconfigured.
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 16);
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16);
    const mix = { ALBAY: past, "CAMARINES SUR": future };
    check("mixed map: REGION not active while CAMARINES SUR's own future date hasn't arrived",
      evalGating(mix, "REGION") === false, JSON.stringify(mix));
    check("mixed map: ALBAY's own page is active (its date passed)",
      evalGating(mix, "ALBAY") === true, JSON.stringify(mix));
    check("mixed map: CAMARINES SUR's own page is not active yet",
      evalGating(mix, "CAMARINES SUR") === false, JSON.stringify(mix));
    check("mixed map: an entirely unconfigured area (MASBATE) is active regardless of the other two",
      evalGating(mix, "MASBATE") === true, JSON.stringify(mix));
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nAWARDEE RECOGNITION PER-PROVINCE ACTIVATION SCHEDULING WORKS AS SPECIFIED"
    : "\nACTIVATION SCHEDULING ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
