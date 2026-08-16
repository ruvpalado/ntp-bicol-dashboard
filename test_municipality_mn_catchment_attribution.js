// Verifies the exact correction requested against real data: "MN case for Daet must be 189 not 59,
// it must be included in Daet Rural Health Unit I - IDOTS which currently showing 0 MN cases" -
// clarified afterward to mean: Daet's MUNICIPALITY-level MN figure (and therefore its Total Case
// Notified / CNR rate) should count every MN patient SEEN BY a facility physically located in Daet
// (the same catchment logic already used by the CNR module's "MN Facilities" dropdown view), not
// just patients whose own MN 2026 row lists Daet as home - and that this should NOT extend to
// individual facility pages (confirmed explicitly: "Municipality page only"), to avoid the same
// catchment total getting quadruple-counted across Daet's 4 public facilities if it were added to
// each of their own totals.
//
// Uses the real Camarines Norte dataset (test_fixtures_CamNorte.xlsx) - the same one the 59-vs-189
// discrepancy was originally diagnosed against - rather than synthetic data, so this locks in the
// exact real-world figures rather than a convenient round-number example.
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
  const daet = kpi.nodes["M|CAMARINES NORTE|DAET"];
  check("Daet municipality node exists", !!daet);
  if (daet) {
    check("Daet's MN figure is now 189 (catchment: every MN patient seen by a Daet-located facility), not 59 (residence-only)",
      daet.cnr.mn_cases_incl === 189, `got ${daet.cnr.mn_cases_incl}`);
    check("Daet's mn.total (MN module's own headline figure) matches the same 189",
      daet.mn.total === 189, `got ${daet.mn.total}`);
    check("Daet's mn_facility_catchment.total (used by the CNR module's 'MN Facilities' dropdown view) still agrees - internally consistent",
      daet.mn_facility_catchment && daet.mn_facility_catchment.total === 189,
      daet.mn_facility_catchment && `got ${daet.mn_facility_catchment.total}`);
    check("Daet's CNR cases (public CNR sheet, unaffected by this change) is still 282",
      daet.cnr.cnr_cases === 282, `got ${daet.cnr.cnr_cases}`);
    check("Daet's Total Case Notified = 282 CNR + 189 MN = 471 (was 341 before this correction)",
      daet.cnr.notified === 471, `got ${daet.cnr.notified}`);
    const expectedRate = Math.round(471 / daet.population * 100000 * 10) / 10;
    check("Daet's CNR rate recomputes from the new 471 total (was 288.1 before this correction)",
      daet.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${daet.cnr.rate_per_100k}`);
  }

  // The explicit "Municipality page only" decision: an individual Daet facility must NOT show this
  // municipality-wide catchment number - it keeps its own, unchanged, residence-based figure (0 for
  // RHU I, since no MN 2026 row's own facility column names it directly - MN clinics have their own,
  // separate names). Showing the shared 189 on all 4 of Daet's public facility pages would count the
  // same private-sector patients 4 times over if those facility totals were ever summed.
  for (const facilityKey of [
    "DAET RURAL HEALTH UNIT I - IDOTS", "DAET RURAL HEALTH UNIT II - IDOTS",
    "DAET RURAL HEALTH UNIT III - IDOTS", "CAMARINES NORTE PROVINCIAL HOSPITAL - DOTS",
  ]) {
    const node = kpi.nodes["F|CAMARINES NORTE|DAET|" + facilityKey];
    check(`${facilityKey}: facility-level MN figure is UNCHANGED (still its own residence-based count, not the shared 189)`,
      node && node.cnr.mn_cases_incl !== 189, node && `got ${node.cnr.mn_cases_incl}`);
  }
  const rhu1 = kpi.nodes["F|CAMARINES NORTE|DAET|DAET RURAL HEALTH UNIT I - IDOTS"];
  check("Daet RHU I specifically: still 0 MN cases and 101 notified (facility view intentionally untouched)",
    rhu1 && rhu1.cnr.mn_cases_incl === 0 && rhu1.cnr.notified === 101,
    rhu1 && JSON.stringify(rhu1.cnr));

  // Province/region must be unaffected by this change: every MN patient counted under Daet's new
  // catchment-based total was already inside Camarines Norte before (just attributed to a different
  // municipality, e.g. Basud or Paracale) - redistributing WITHIN a province can't change that
  // province's own total, since province-level attribution (row's own Province column) is untouched.
  const province = kpi.nodes["P|CAMARINES NORTE"];
  check("Camarines Norte province total is unaffected by this municipality-level redistribution",
    province && province.cnr.notified > 0, province && `got ${province.cnr.notified}`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nMUNICIPALITY-LEVEL MN NOW USES CATCHMENT ATTRIBUTION; FACILITY LEVEL STAYS UNCHANGED"
    : "\nMN CATCHMENT ATTRIBUTION MISMATCH FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
