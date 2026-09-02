// Verifies the requested Laboratory Module period behavior:
//   Quarter Column: 1->Q1, 2->Q2, 3->Q3, 4->Q4.
//   Month Column: 1->January, ..., 12->December.
//   No Selection -> show all available data across months and quarters (full dataset).
//   With Selection -> show only data tied to the selected month or quarter.
//
// Implemented in vendor/ntp_pipeline_browser.js: aggregateLongReport() now tags each long/tidy-format
// lab row with .Month/.Quarter (derived from that row's own Month/Quarter columns), building a
// separate byPeriod array alongside the existing full-total array. nodeForPeriod()'s by_month/
// by_quarter precompute then filters the lab sheets (Screening Presumptive, Sputum Examination, Stool
// Base, GenXpert, Parago, Table E, PICT) by period for the first time - previously these sources were
// always shown in full regardless of which month/quarter was selected (see the pipeline's own former
// log line: "Screening & Presumptive and Laboratory sources are pre-aggregated with no date column and
// show full-period totals regardless of month/quarter selection").
//
// This test builds a small, real SCREENING PRESUMPTIVE long/tidy sheet by hand (no upload API
// involved - the raw pipeline is exercised directly) with rows spread across distinct
// months/quarters, plus one row that supplies only a Quarter (no Month) to prove the "quarter-only
// row visible in its quarter, invisible in any single month" rule.
const XLSX = require("xlsx");
const fs = require("fs");
const template = require(__dirname + "/lib/provinceTemplate");
const { runPipelineOnWorkbook } = require(__dirname + "/lib/pipeline");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

// Reuse the real POPULATION sheet from the format fixture rather than hand-building the
// hierarchical Region->Province->Municipality->Barangay grid - population figures themselves are
// irrelevant to this test, only that hasPopulation() and rate calculations don't blow up.
const formatBuf = fs.readFileSync(__dirname + "/test_fixtures_Format.xlsx");
const parsedFormat = template.parseUpload(formatBuf, "Format.xlsx");
const populationGrid = parsedFormat["POPULATION"];

const SCR_HEADER = [
  "Region", "Province/HUC", "City-Municipality", "Facility", "Year", "Quarter", "Month",
  "Diagnostic Activity", "Case Finding Method", "Presumptive Ds/Dr", "Value",
];
function scrRow({ province, facility, quarter, month, value }) {
  return [
    "Region V (Bicol Region)", province, province + " CITY", facility, 2026,
    quarter === undefined ? null : quarter, month === undefined ? null : month,
    "Number Screened by CXR", "Active Case Finding", "", value,
  ];
}

const scrRows = [
  SCR_HEADER,
  scrRow({ province: "ALBAY", facility: "TEST FACILITY A", quarter: 1, month: 1, value: 10 }),  // Jan, Q1
  scrRow({ province: "ALBAY", facility: "TEST FACILITY A", quarter: 1, month: 2, value: 20 }),  // Feb, Q1
  scrRow({ province: "ALBAY", facility: "TEST FACILITY A", quarter: 1, month: 3, value: 5 }),   // Mar, Q1
  scrRow({ province: "ALBAY", facility: "TEST FACILITY A", quarter: 2, month: 4, value: 100 }), // Apr, Q2
  scrRow({ province: "ALBAY", facility: "TEST FACILITY A", quarter: 3, value: 7 }),              // Q3 only, no Month
];

const workbook = { SheetNames: ["POPULATION", "SCREENING PRESUMPTIVE"], Sheets: {
  POPULATION: populationGrid,
  "SCREENING PRESUMPTIVE": scrRows,
} };

const kpi = runPipelineOnWorkbook(workbook);
const region = kpi.nodes["REGION"];

(function run() {
  check("REGION node exists", !!region, "no REGION node in output");
  if (!region) { report(); return; }

  check("no-selection total = every row summed (10+20+5+100+7=142)",
    region.screening && region.screening.screened_cxr === 142,
    region.screening && JSON.stringify(region.screening.screened_cxr));

  check("Quarter 1 (value 1) -> Q1: sums exactly the 3 rows tagged Jan/Feb/Mar (10+20+5=35)",
    region.by_quarter && region.by_quarter.Q1 && region.by_quarter.Q1.screening.screened_cxr === 35,
    region.by_quarter && JSON.stringify(region.by_quarter.Q1 && region.by_quarter.Q1.screening.screened_cxr));

  check("Quarter 2 (value 2) -> Q2: sums exactly the April row (100)",
    region.by_quarter && region.by_quarter.Q2 && region.by_quarter.Q2.screening.screened_cxr === 100,
    region.by_quarter && JSON.stringify(region.by_quarter.Q2 && region.by_quarter.Q2.screening.screened_cxr));

  check("Quarter 3 (value 3) -> Q3: sums exactly the Quarter-only row (7), even with no Month",
    region.by_quarter && region.by_quarter.Q3 && region.by_quarter.Q3.screening.screened_cxr === 7,
    region.by_quarter && JSON.stringify(region.by_quarter.Q3 && region.by_quarter.Q3.screening.screened_cxr));

  check("Quarter 4 (value 4) -> Q4: no data uploaded for it, correctly zero",
    region.by_quarter && region.by_quarter.Q4 && region.by_quarter.Q4.screening.screened_cxr === 0,
    region.by_quarter && JSON.stringify(region.by_quarter.Q4 && region.by_quarter.Q4.screening.screened_cxr));

  check("Month 1 (value 1) -> January: sums exactly the January row (10)",
    region.by_month && region.by_month.January && region.by_month.January.screening.screened_cxr === 10,
    region.by_month && JSON.stringify(region.by_month.January && region.by_month.January.screening.screened_cxr));

  check("Month 2 (value 2) -> February: sums exactly the February row (20)",
    region.by_month && region.by_month.February && region.by_month.February.screening.screened_cxr === 20,
    region.by_month && JSON.stringify(region.by_month.February && region.by_month.February.screening.screened_cxr));

  check("Month 4 (value 4) -> April: sums exactly the April row (100) - exact-month rows work the same in month view as quarter view",
    region.by_month && region.by_month.April && region.by_month.April.screening.screened_cxr === 100,
    region.by_month && JSON.stringify(region.by_month.April && region.by_month.April.screening.screened_cxr));

  // THE CORE RULE for a Quarter-only row: it belongs unambiguously to Q3, but NOT to any specific
  // month within Q3, since which of July/August/September it actually happened in is unknown - it
  // must not silently be guessed into one.
  check("a Quarter-only row (Q3, no Month) does NOT appear under July",
    region.by_month && region.by_month.July && region.by_month.July.screening.screened_cxr === 0,
    region.by_month && JSON.stringify(region.by_month.July && region.by_month.July.screening.screened_cxr));
  check("a Quarter-only row (Q3, no Month) does NOT appear under August",
    region.by_month && region.by_month.August && region.by_month.August.screening.screened_cxr === 0,
    region.by_month && JSON.stringify(region.by_month.August && region.by_month.August.screening.screened_cxr));
  check("a Quarter-only row (Q3, no Month) does NOT appear under September",
    region.by_month && region.by_month.September && region.by_month.September.screening.screened_cxr === 0,
    region.by_month && JSON.stringify(region.by_month.September && region.by_month.September.screening.screened_cxr));

  // Province-level slice: same guarantees should hold one level down the hierarchy, not just at REGION.
  const albay = kpi.nodes["P|ALBAY"];
  check("ALBAY province node: no-selection total matches the region total (single-province dataset)",
    albay && albay.screening.screened_cxr === 142, albay && JSON.stringify(albay.screening.screened_cxr));
  check("ALBAY province node: Q1 slice matches the region's Q1 slice (35)",
    albay && albay.by_quarter.Q1.screening.screened_cxr === 35,
    albay && JSON.stringify(albay.by_quarter.Q1.screening.screened_cxr));

  report();
})();

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nLABORATORY MODULE MONTH/QUARTER FILTERING WORKS AS SPECIFIED"
    : "\nPERIOD FILTERING ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
