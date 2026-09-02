// Verifies the exact guarantee requested: "for daet RHU I, MN cases must be computed base on MN
// 2026 Sheet but dont include cases from RACELIS-TIONGSON MEDICAL CLINIC AND HOSPITAL - MTBN since
// it is not located in Daet Camarines Norte."
//
// This is already how the pipeline is built. vendor/ntp_pipeline_browser.js's built-in
// FACILITY_MUNICIPALITY_REFERENCE table (~line 883) states this facility's municipality as LABO,
// not DAET. Daet's public facilities (including "DAET RURAL HEALTH UNIT I - IDOTS") get their MN
// catchment cases via mnCatchmentFor(), which only pulls in MN 2026 rows whose facility resolves
// (via fac2muni) to the SAME municipality being asked about - so a facility the reference table
// places in Labo can never contribute to Daet's catchment, no matter what its own MN 2026 rows say.
//
// Critically, `Object.assign(fac2muni, FACILITY_MUNICIPALITY_REFERENCE)` (~line 2230) applies the
// built-in reference AFTER both the majority-vote-from-line-list-rows and the uploaded Facility
// List roster have already run, unconditionally overwriting either for any facility the reference
// table names - so the reference is the final word for this facility, not just a fallback. This
// test proves that guarantee under the WORST case: every single one of this facility's MN 2026 rows
// (existing plus several new ones) claims City/Municipality = "Daet", which would normally win a
// majority vote outright - and confirms it still resolves to Labo and Daet RHU I's MN catchment
// total is completely unaffected.
const XLSX = require("xlsx");
const fs = require("fs");

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const { runPipelineOnWorkbook } = require(BASE + "lib/pipeline");

const FIXTURE_PATH = BASE + "test_fixtures_CamNorte.xlsx";
const fixtureBuf = fs.readFileSync(FIXTURE_PATH);
const parsedBase = template.parseUpload(fixtureBuf, "CamNorte.xlsx");

const FACILITY = "RACELIS-TIONGSON MEDICAL CLINIC AND HOSPITAL - MTBN";

function buildWorkbook(claimedMuni) {
  const out = {};
  for (const [name, grid] of Object.entries(parsedBase)) out[name] = grid.map((r) => (r ? r.slice() : r));
  const mnGrid = out["MN 2026"];
  const header = mnGrid[0].map((c) => (c === null ? "" : String(c).trim()));
  const muniIdx = header.indexOf("City/Municipality");
  const facIdx = header.indexOf("Screening/Diagnosing Health Facility");
  const rgIdx = header.indexOf("Registration Group");
  const dateIdx = header.indexOf("Date of Diagnosis");
  const provIdx = header.indexOf("Province");

  // Re-point every EXISTING row for this facility to the claimed municipality too, so nothing in
  // the fixture's original (correct) data softens the adversarial test.
  let switched = 0;
  for (let i = 1; i < mnGrid.length; i++) {
    const row = mnGrid[i];
    if (row && String(row[facIdx] || "").trim().toUpperCase() === FACILITY) {
      row[muniIdx] = claimedMuni;
      switched++;
    }
  }
  // Stack the majority vote hard: several fresh rows, all claiming the same (wrong) municipality.
  for (let i = 0; i < 6; i++) {
    const row = new Array(header.length).fill(null);
    row[dateIdx] = "2026-0" + ((i % 9) + 1) + "-12";
    row[provIdx] = "Camarines Norte";
    row[muniIdx] = claimedMuni;
    row[facIdx] = FACILITY;
    row[rgIdx] = "New";
    mnGrid.push(row);
  }
  out["MN 2026"] = mnGrid;
  return { sheets: out, switched, added: 6 };
}

function toWorkbookObject(sheets) {
  const SheetNames = Object.keys(sheets);
  const Sheets = {};
  for (const name of SheetNames) Sheets[name] = XLSX.utils.aoa_to_sheet(sheets[name].length ? sheets[name] : [[]]);
  return { SheetNames, Sheets };
}

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(function run() {
  // Baseline: the fixture's own (unmodified) data - RHU I's MN catchment total, for comparison.
  const baselineKpi = runPipelineOnWorkbook(toWorkbookObject(
    (() => { const o = {}; for (const [n, g] of Object.entries(parsedBase)) o[n] = g.map((r) => (r ? r.slice() : r)); return o; })()
  ));
  const baselineTotal = baselineKpi.nodes["F|CAMARINES NORTE|DAET|DAET RURAL HEALTH UNIT I - IDOTS"].mn_facility_catchment.total;

  // Adversarial: every one of this facility's rows (existing + 6 new) claims City/Municipality =
  // "Daet" - the majority-vote fallback, taken alone, would place the facility in Daet.
  const { sheets, switched, added } = buildWorkbook("Daet");
  const kpi = runPipelineOnWorkbook(toWorkbookObject(sheets));

  check("test setup actually re-pointed existing rows for this facility (not a no-op)", switched >= 1, `switched ${switched}`);

  const daetNodeKeys = Object.keys(kpi.nodes).filter((k) => k.startsWith("F|CAMARINES NORTE|DAET") && k.includes("RACELIS"));
  check("even with every MN row claiming Daet, no RACELIS-TIONGSON facility node is created under Daet",
    daetNodeKeys.length === 0, JSON.stringify(daetNodeKeys));

  const laboNodeKeys = Object.keys(kpi.nodes).filter((k) => k.startsWith("F|CAMARINES NORTE|LABO") && k.includes("RACELIS"));
  check("the facility still resolves to Labo (its actual, reference-table location), not wherever its rows claim",
    laboNodeKeys.length > 0, JSON.stringify(laboNodeKeys));

  const rhu1 = kpi.nodes["F|CAMARINES NORTE|DAET|DAET RURAL HEALTH UNIT I - IDOTS"];
  check("Daet RHU I's MN catchment total is COMPLETELY UNCHANGED by this facility's (wrongly-claimed) Daet rows - THE CORE GUARANTEE",
    rhu1.mn_facility_catchment.total === baselineTotal,
    `baseline ${baselineTotal}, now ${rhu1.mn_facility_catchment && rhu1.mn_facility_catchment.total}`);

  const laboNode = kpi.nodes["M|CAMARINES NORTE|LABO"];
  check("Labo's own municipality-level MN total DOES reflect these rows (they're not silently dropped, just correctly attributed)",
    laboNode && laboNode.cnr.mn_cases_incl >= 7, laboNode && JSON.stringify(laboNode.cnr.mn_cases_incl));

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nRACELIS-TIONGSON STAYS OUT OF DAET (AND DAET RHU I) NO MATTER WHAT ITS OWN ROWS CLAIM"
    : "\nEXCLUSION GUARANTEE BROKEN");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
