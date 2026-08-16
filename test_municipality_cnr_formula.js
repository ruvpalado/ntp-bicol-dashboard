// Verifies the exact municipality-level CNR formula requested:
//
//   For municipalities with MULTIPLE facilities:
//     1. Aggregate the total CNR cases and total MN cases reported by all facilities under the
//        municipality.
//     2. Divide the combined total by the municipality's population.
//     3. Multiply by 100,000 to obtain the CNR value.
//
//   For municipalities with a SINGLE facility:
//     1. Divide the total cases reported by the facility by the municipality's population.
//     2. Multiply by 100,000 to obtain the CNR value.
//
// This is already how vendor/ntp_pipeline_browser.js's municipality nodes (nodeFor(province,
// municipality, null) - no facility argument) are built: population comes from the plain municipal
// figure (muniPopulation[province+"|"+municipality]) via computeNode's notified/population*100000,
// never the per-facility catchment split (that split only ever touches *facility*-level nodes - see
// the "Facility-level CNR denominators" block right after nodeFor, whose own comment says
// "municipality/province/region totals are untouched"). A single-facility municipality runs through
// the exact same code path, so the "different" single-facility formula in the spec above is
// mathematically identical to the multi-facility one - this test proves both arithmetically.
//
// CNR cases aggregate by the row's own City/Municipality column, summed across every public
// facility that reported under this municipality (CNR sheet rows are never attributed any other
// way). MN cases aggregate differently, per a later, more specific instruction confirmed against
// real Daet, Camarines Norte data: a municipality's MN total counts every MN 2026 patient SEEN BY a
// private facility physically LOCATED in that municipality (resolved the same way as the CNR
// module's "MN Facilities" catchment view), not just patients whose own MN row happens to list that
// municipality as home - a private clinic serving a wide catchment area (referrals from neighboring
// towns) would otherwise be undercounted. This only applies to MUNICIPALITY nodes; an individual
// facility's own page is unaffected (see test_racelis_tiongson_daet_exclusion.js for that
// guarantee), and so is province/region - see vendor/ntp_pipeline_browser.js's nodeFor() comment
// above its mnSub/mnSubNr assignment for the full rationale.
const XLSX = require("xlsx");
const fs = require("fs");

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const { runPipelineOnWorkbook } = require(BASE + "lib/pipeline");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);
const parsedBase = template.parseUpload(formatBuffer, "Format.xlsx");

// Confirmed from the fixture's own POPULATION sheet: Albay > Bacacay = 75,567 (multi-facility
// municipality below), Albay > Jovellar = 18,234 (single-facility municipality below). Left
// completely untouched - the point is to prove the formula against the SAME population figures the
// real dashboard would use for these towns, not numbers picked to make the arithmetic convenient.
const BACACAY_POP = 75567;
const JOVELLAR_POP = 18234;

function buildRow(header, values) {
  const row = new Array(header.length).fill(null);
  for (const [col, val] of Object.entries(values)) {
    const idx = header.indexOf(col);
    if (idx === -1) throw new Error(`Column "${col}" not found in header ${JSON.stringify(header)}`);
    row[idx] = val;
  }
  return row;
}

function buildWorkbook() {
  const out = {};
  for (const [name, grid] of Object.entries(parsedBase)) out[name] = grid.map((r) => (r ? r.slice() : r));

  const cnrSpec = template.findSpec("CNR 2026 ");
  const cnrHeader = out["CNR 2026 "][0].map((c) => (c === null ? "" : String(c).trim()));
  const cnrGrid = out["CNR 2026 "].slice(0, cnrSpec.headerRows);

  const mnSpec = template.findSpec("MN 2026");
  const mnHeader = out["MN 2026"][0].map((c) => (c === null ? "" : String(c).trim()));
  const mnGrid = out["MN 2026"].slice(0, mnSpec.headerRows);

  function addCnr(muni, facility, n, dayBase) {
    for (let i = 0; i < n; i++) {
      cnrGrid.push(buildRow(cnrHeader, {
        "Date of Notification": "2026-0" + (((dayBase + i) % 9) + 1) + "-10",
        Province: "Albay",
        "City/Municipality": muni,
        "Screening/Diagnosing Health Facility": facility,
        "Registration Group": "New",
        Type: "DSTB",
      }));
    }
  }
  function addMn(muni, facility, n, dayBase) {
    for (let i = 0; i < n; i++) {
      mnGrid.push(buildRow(mnHeader, {
        "Date of Diagnosis": "2026-0" + (((dayBase + i) % 9) + 1) + "-10",
        Province: "Albay",
        "City/Municipality": muni,
        "Screening/Diagnosing Health Facility": facility,
        "Registration Group": "New",
        Type: "DSTB",
      }));
    }
  }

  // Bacacay: TWO public CNR facilities (5 + 3 = 8 rows) plus TWO private MN clinics physically
  // located in Bacacay (2 + 1 = 3 rows) -> 11 total. MN facility names use the real "- MTBN" suffix
  // convention (see FACILITY_MUNICIPALITY_REFERENCE/mnFacilitySet in the pipeline) so they resolve
  // as private/MN facilities and get picked up by the municipality's catchment, exactly like real
  // uploaded data.
  addCnr("Bacacay", "BACACAY RURAL HEALTH UNIT", 5, 0);
  addCnr("Bacacay", "BACACAY HEALTH CENTER", 3, 2);
  addMn("Bacacay", "BACACAY MEDICAL CLINIC - MTBN", 2, 1);
  addMn("Bacacay", "BACACAY DIAGNOSTIC CENTER - MTBN", 1, 4);

  // Jovellar: ONE public CNR facility (4 rows) plus ONE private MN clinic (1 row) -> 5 total.
  addCnr("Jovellar", "JOVELLAR HEALTH CENTER", 4, 0);
  addMn("Jovellar", "JOVELLAR MEDICAL CLINIC - MTBN", 1, 3);

  out["CNR 2026 "] = cnrGrid;
  out["MN 2026"] = mnGrid;
  return out;
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
  const sheets = buildWorkbook();
  const kpi = runPipelineOnWorkbook(toWorkbookObject(sheets));

  const bacacay = kpi.nodes["M|ALBAY|BACACAY"];
  check("Bacacay municipality node exists", !!bacacay, Object.keys(kpi.nodes).filter((k) => k.startsWith("M|ALBAY")).join(", "));
  if (bacacay) {
    check("Bacacay population matches the POPULATION sheet's own figure (untouched, no catchment split)",
      bacacay.population === BACACAY_POP, `got ${bacacay.population}`);
    check("Bacacay's CNR notified = 8 CNR rows + 3 MN rows from BOTH facilities combined = 11 (step 1: aggregate)",
      bacacay.cnr.notified === 11, `got ${bacacay.cnr.notified}`);
    const expectedRate = Math.round(11 / BACACAY_POP * 100000 * 10) / 10;
    check("Bacacay's CNR rate = notified / municipality population * 100,000 (steps 2-3), computed the SAME way the dashboard does",
      bacacay.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${bacacay.cnr.rate_per_100k}`);
  }

  const jovellar = kpi.nodes["M|ALBAY|JOVELLAR"];
  check("Jovellar municipality node exists", !!jovellar);
  if (jovellar) {
    check("Jovellar population matches the POPULATION sheet's own figure",
      jovellar.population === JOVELLAR_POP, `got ${jovellar.population}`);
    check("Jovellar's CNR notified = 4 CNR rows + 1 MN row from its single facility = 5 (single-facility case)",
      jovellar.cnr.notified === 5, `got ${jovellar.cnr.notified}`);
    const expectedRate = Math.round(5 / JOVELLAR_POP * 100000 * 10) / 10;
    check("Jovellar's CNR rate = its own total / municipality population * 100,000 - " +
      "arithmetically identical formula to the multi-facility case, just with one facility contributing",
      jovellar.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${jovellar.cnr.rate_per_100k}`);
  }

  // The province total must equal the sum of both municipalities (16 total, since other Albay
  // municipalities in this synthetic dataset have zero rows) - confirms aggregation composes
  // correctly up the hierarchy, not just at the municipality level in isolation.
  const albay = kpi.nodes["P|ALBAY"];
  check("Albay province total = Bacacay's 11 + Jovellar's 5 = 16 (aggregation composes correctly up the hierarchy)",
    albay && albay.cnr.notified === 16, albay && `got ${albay.cnr.notified}`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nMUNICIPALITY CNR MATCHES THE SPECIFIED FORMULA, MULTI- AND SINGLE-FACILITY ALIKE"
    : "\nMUNICIPALITY CNR FORMULA MISMATCH FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
