// Extends test_municipality_cnr_formula.js's proof to two more real municipalities, to confirm the
// municipality-level CNR/MN formula (and the catchment-based MN attribution fix from
// vendor/ntp_pipeline_browser.js's nodeFor()/nodeForPeriod()) is a GENERIC rule - not something
// special-cased to Daet, Camarines Norte - as requested: "do this also for Sorsogon City for
// Province of Sorsogon and Virac for Catanduanes."
//
// Sorsogon City (Sorsogon): multi-facility case - 2 public CNR facilities + 2 private MN clinics.
// Virac (Catanduanes): single-facility case - 1 public CNR facility + 1 private MN clinic.
//
// Population figures (190,601 for Sorsogon City; 79,548 for Virac) are the REAL figures from the
// project's own POPULATION sheet template (test_fixtures_Format.xlsx), not invented numbers - only
// the CNR/MN case rows below are synthetic, since no real uploaded file for either province is
// available in this environment. MN facility names use the real "- MTBN" private-clinic naming
// convention so they resolve as MN/private facilities exactly like genuine uploaded data (a plain
// name without that suffix would not be picked up by the catchment, as test_municipality_cnr_
// formula.js's own history shows).
const XLSX = require("xlsx");
const fs = require("fs");

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const { runPipelineOnWorkbook } = require(BASE + "lib/pipeline");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);
const parsedBase = template.parseUpload(formatBuffer, "Format.xlsx");

// Confirmed from the fixture's own POPULATION sheet.
const SORSOGON_CITY_POP = 190601;
const VIRAC_POP = 79548;

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

  function addCnr(province, muni, facility, n, dayBase) {
    for (let i = 0; i < n; i++) {
      cnrGrid.push(buildRow(cnrHeader, {
        "Date of Notification": "2026-0" + (((dayBase + i) % 9) + 1) + "-10",
        Province: province,
        "City/Municipality": muni,
        "Screening/Diagnosing Health Facility": facility,
        "Registration Group": "New",
        Type: "DSTB",
      }));
    }
  }
  function addMn(province, muni, facility, n, dayBase) {
    for (let i = 0; i < n; i++) {
      mnGrid.push(buildRow(mnHeader, {
        "Date of Diagnosis": "2026-0" + (((dayBase + i) % 9) + 1) + "-10",
        Province: province,
        "City/Municipality": muni,
        "Screening/Diagnosing Health Facility": facility,
        "Registration Group": "New",
        Type: "DSTB",
      }));
    }
  }

  // Sorsogon City: TWO public CNR facilities (6 + 4 = 10 rows) plus TWO private MN clinics (3 + 2 =
  // 5 rows) -> 15 total, matching the multi-facility branch of the requested formula.
  addCnr("Sorsogon", "Sorsogon City", "SORSOGON CITY RURAL HEALTH UNIT I", 6, 0);
  addCnr("Sorsogon", "Sorsogon City", "SORSOGON CITY HEALTH OFFICE", 4, 3);
  addMn("Sorsogon", "Sorsogon City", "SORSOGON CITY MEDICAL CLINIC - MTBN", 3, 1);
  addMn("Sorsogon", "Sorsogon City", "SORSOGON CITY DIAGNOSTIC CENTER - MTBN", 2, 5);

  // Virac: ONE public CNR facility (7 rows) plus ONE private MN clinic (3 rows) -> 10 total,
  // matching the single-facility branch of the requested formula. Deliberately NOT using the real
  // "VIRAC RURAL HEALTH UNIT - IDOTS" facility name here: that exact name is one of 56 facilities
  // the fixture's own embedded Facility List roster misfiles under the wrong province heading (a
  // pre-existing data quality quirk of the fixture, already self-reported via data_quality_notes -
  // "Facility List: no facilities are listed under CATANDUANES... 56 facilit(ies) sit under a
  // province heading that disagrees with their own Municipality/City"), which would silently pull
  // this test's rows out of Catanduanes and into whatever province they're misfiled under - nothing
  // to do with the pipeline logic under test here.
  addCnr("Catanduanes", "Virac", "VIRAC POBLACION HEALTH CENTER", 7, 0);
  addMn("Catanduanes", "Virac", "VIRAC MEDICAL CLINIC - MTBN", 3, 2);

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

  const sorsogonCity = kpi.nodes["M|SORSOGON|SORSOGON CITY"];
  check("Sorsogon City municipality node exists", !!sorsogonCity,
    Object.keys(kpi.nodes).filter((k) => k.startsWith("M|SORSOGON")).join(", "));
  if (sorsogonCity) {
    check("Sorsogon City population matches the POPULATION sheet's own figure",
      sorsogonCity.population === SORSOGON_CITY_POP, `got ${sorsogonCity.population}`);
    check("Sorsogon City CNR cases = 6 + 4 = 10 (both public facilities combined)",
      sorsogonCity.cnr.cnr_cases === 10, `got ${sorsogonCity.cnr.cnr_cases}`);
    check("Sorsogon City MN cases = 3 + 2 = 5 (both private MN clinics combined, catchment-based)",
      sorsogonCity.cnr.mn_cases_incl === 5, `got ${sorsogonCity.cnr.mn_cases_incl}`);
    check("Sorsogon City notified = 10 + 5 = 15 (multi-facility aggregation)",
      sorsogonCity.cnr.notified === 15, `got ${sorsogonCity.cnr.notified}`);
    const expectedRate = Math.round(15 / SORSOGON_CITY_POP * 100000 * 10) / 10;
    check("Sorsogon City rate = 15 / 190,601 * 100,000, same formula as every other municipality",
      sorsogonCity.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${sorsogonCity.cnr.rate_per_100k}`);
  }

  const virac = kpi.nodes["M|CATANDUANES|VIRAC"];
  check("Virac municipality node exists", !!virac,
    Object.keys(kpi.nodes).filter((k) => k.startsWith("M|CATANDUANES")).join(", "));
  if (virac) {
    check("Virac population matches the POPULATION sheet's own figure",
      virac.population === VIRAC_POP, `got ${virac.population}`);
    check("Virac CNR cases = 7 (its single public facility)",
      virac.cnr.cnr_cases === 7, `got ${virac.cnr.cnr_cases}`);
    check("Virac MN cases = 3 (its single private MN clinic, catchment-based)",
      virac.cnr.mn_cases_incl === 3, `got ${virac.cnr.mn_cases_incl}`);
    check("Virac notified = 7 + 3 = 10 (single-facility case)",
      virac.cnr.notified === 10, `got ${virac.cnr.notified}`);
    const expectedRate = Math.round(10 / VIRAC_POP * 100000 * 10) / 10;
    check("Virac rate = 10 / 79,548 * 100,000 - identical formula to the multi-facility case above",
      virac.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${virac.cnr.rate_per_100k}`);
  }

  // Facility-level pages must stay untouched here too, same guarantee as Daet's.
  const sorsogonRhu1 = kpi.nodes["F|SORSOGON|SORSOGON CITY|SORSOGON CITY RURAL HEALTH UNIT I"];
  check("Sorsogon City RHU I facility page: MN is its own residence-based count (0, since no MN row names this facility directly), not the municipality's 5-case catchment total",
    sorsogonRhu1 && sorsogonRhu1.cnr.mn_cases_incl === 0, sorsogonRhu1 && JSON.stringify(sorsogonRhu1.cnr));

  const viracRhu = kpi.nodes["F|CATANDUANES|VIRAC|VIRAC POBLACION HEALTH CENTER"];
  check("Virac's own facility page: CNR-only (7), MN NOT added in - matches the 'municipality page only' rule",
    viracRhu && viracRhu.cnr.notified === 7 && viracRhu.cnr.mn_cases_incl === 0,
    viracRhu && JSON.stringify(viracRhu.cnr));

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nTHE SAME FORMULA HOLDS FOR SORSOGON CITY AND VIRAC - IT'S A GENERIC RULE, NOT DAET-SPECIFIC"
    : "\nFORMULA MISMATCH FOUND FOR SORSOGON CITY / VIRAC");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
