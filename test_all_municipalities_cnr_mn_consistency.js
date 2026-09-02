// Generic, whole-dataset audit: "do this to all province to ensure all data is accurate" - checks
// that EVERY municipality's CNR total exactly equals the sum of its own public facilities' own CNR
// totals, for every province present in the loaded data, not just Daet/Camarines Norte where the
// discrepancy was first reported. Nothing here is hardcoded to a specific province or number - it
// walks whatever municipalities/facilities actually exist in the KPI output, so it applies to any
// dataset (this fixture today, a real upload for any other province tomorrow) without editing this
// file.
//
// Run against the real Camarines Norte dataset (the only province with real case data available in
// this environment) - all 12 of its municipalities are audited below, not just Daet. The underlying
// fix (cnrCatchmentFor()/mnCatchmentFor() in vendor/ntp_pipeline_browser.js's nodeFor()/
// nodeForPeriod()) takes `province`/`municipality` as plain parameters with no province-specific
// logic anywhere, so the SAME guarantee already proven for Sorsogon City and Virac (see
// test_sorsogon_virac_cnr_formula.js) applies identically here and to every other province - this
// test is what would catch it if that generic guarantee were ever accidentally narrowed back down to
// one area.
const template = require(__dirname + "/lib/provinceTemplate");
const fs = require("fs");
const XLSX = require("xlsx");
const { runPipelineOnWorkbook } = require(__dirname + "/lib/pipeline");

const FIXTURE_PATH = __dirname + "/test_fixtures_CamNorte.xlsx";
const fixtureBuf = fs.readFileSync(FIXTURE_PATH);
const parsed = template.parseUpload(fixtureBuf, "CamNorte.xlsx");
const SheetNames = Object.keys(parsed);
const Sheets = {};
for (const name of SheetNames) Sheets[name] = XLSX.utils.aoa_to_sheet(parsed[name].length ? parsed[name] : [[]]);
const kpi = runPipelineOnWorkbook({ SheetNames, Sheets });

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(function run() {
  const muniKeys = Object.keys(kpi.nodes).filter((k) => k.startsWith("M|"));
  check("at least one municipality node exists to audit (fixture actually has data)", muniKeys.length > 0);

  const provincesAudited = new Set();
  let municipalitiesAudited = 0;
  let totalCnrCasesAudited = 0;

  for (const muniKey of muniKeys) {
    const parts = muniKey.split("|");
    const province = parts[1], muniName = parts[2];
    const muniNode = kpi.nodes[muniKey];
    if (!muniNode || !muniNode.population) continue; // no population -> not a real reporting area for this dataset

    // Every facility node under this exact province/municipality, EXCLUDING MN-suffixed (private)
    // ones - those feed mn_cases_incl separately via mnCatchmentFor(), not cnr_cases.
    const facKeys = Object.keys(kpi.nodes).filter(
      (k) => k.startsWith(`F|${province}|${muniName}|`) && !/-\s*(MTBN|MBTN)\s*$/.test(k)
    );
    if (!facKeys.length) continue; // nothing to cross-check for a municipality with no public facility rows

    let facilitySum = 0;
    for (const fk of facKeys) facilitySum += kpi.nodes[fk].cnr.cnr_cases;

    provincesAudited.add(province);
    municipalitiesAudited++;
    totalCnrCasesAudited += muniNode.cnr.cnr_cases;

    check(`${province} / ${muniName}: municipality CNR total (${muniNode.cnr.cnr_cases}) matches the sum of its own ${facKeys.length} facility page(s) (${facilitySum})`,
      muniNode.cnr.cnr_cases === facilitySum,
      `municipality says ${muniNode.cnr.cnr_cases}, facilities sum to ${facilitySum} - a ${Math.abs(muniNode.cnr.cnr_cases - facilitySum)}-case gap`);

    // notified must always equal cnr_cases + mn_cases_incl - a basic internal-consistency check that
    // would catch the two components silently drifting apart from each other.
    check(`${province} / ${muniName}: notified (${muniNode.cnr.notified}) = cnr_cases (${muniNode.cnr.cnr_cases}) + mn_cases_incl (${muniNode.cnr.mn_cases_incl})`,
      muniNode.cnr.notified === muniNode.cnr.cnr_cases + muniNode.cnr.mn_cases_incl,
      JSON.stringify(muniNode.cnr));

    // top_facilities (the CNR module's own facility ranking, shown per municipality) must sum to the
    // same cnr_cases - this was the visible symptom of the original bug (100/87/72/23 there vs
    // 101/91/73/46 on each facility's own page).
    const topFacSum = Object.values(muniNode.cnr.top_facilities || {}).reduce((s, v) => s + v, 0);
    // top_facilities is capped to the top 8 - only assert equality when this municipality has 8 or
    // fewer public facilities (otherwise a genuine, expected truncation would look like a mismatch).
    if (facKeys.length <= 8) {
      check(`${province} / ${muniName}: top_facilities breakdown (${topFacSum}) sums to the same cnr_cases (${muniNode.cnr.cnr_cases})`,
        topFacSum === muniNode.cnr.cnr_cases, `top_facilities sums to ${topFacSum}`);
    }
  }

  check("more than one municipality was actually audited (the walk found real data, not an empty dataset)",
    municipalitiesAudited > 5, `only audited ${municipalitiesAudited}`);
  console.log(`\n(Audited ${municipalitiesAudited} municipalities across ${provincesAudited.size} province(s) ` +
    `[${Array.from(provincesAudited).join(", ")}], ${totalCnrCasesAudited.toLocaleString()} total CNR cases cross-checked.)\n`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nEVERY MUNICIPALITY IN EVERY AUDITED PROVINCE IS INTERNALLY CONSISTENT"
    : "\nCNR/MN CONSISTENCY GAP FOUND - SEE ABOVE");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
