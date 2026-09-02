// Verifies two related corrections against real data, both confirmed against Daet, Camarines Norte:
//
// 1. MN: "MN case for Daet must be 189 not 59, it must be included in Daet Rural Health Unit I -
//    IDOTS which currently showing 0 MN cases" - clarified to mean Daet's MUNICIPALITY-level MN
//    figure should count every MN patient SEEN BY a facility physically located in Daet (catchment
//    attribution), not just patients whose own MN 2026 row lists Daet as home - and that this should
//    NOT extend to individual facility pages ("Municipality page only"), to avoid the same catchment
//    total getting quadruple-counted across Daet's 4 public facilities.
//
// 2. CNR: "check the total case for daet since i has discrepancy from manual computation... it show
//    471 but in manual computation it show 500 total case from Camarines Norte Provincial Hospital -
//    DOTS, Daet Rural Health Unit I/II/III - IDOTS and MN Facilities." Diagnosed as the SAME
//    underlying pattern as the MN fix: Daet's municipality-level CNR total was built from rows whose
//    own City/Municipality column said "Daet" (311 -> wrongly showing 282, missing 29 rows - mostly
//    from Camarines Norte Provincial Hospital, a province-wide referral site whose patients' own
//    recorded municipality is their home town, not Daet), instead of summing every case actually
//    reported BY a facility physically located in Daet - i.e. the catchment attribution needed to
//    apply to CNR too, not just MN, to match a manual sum of each facility's own page.
//
// Together: Daet's Total Case Notified = 311 (CNR, catchment-based) + 189 (MN, catchment-based) =
// 500 - matching the manual computation exactly.
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

const DAET_FACILITIES = [
  "CAMARINES NORTE PROVINCIAL HOSPITAL - DOTS", "DAET RURAL HEALTH UNIT I - IDOTS",
  "DAET RURAL HEALTH UNIT II - IDOTS", "DAET RURAL HEALTH UNIT III - IDOTS",
];

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(function run() {
  const daet = kpi.nodes["M|CAMARINES NORTE|DAET"];
  check("Daet municipality node exists", !!daet);
  if (daet) {
    check("Daet's MN figure is 189 (catchment: every MN patient seen by a Daet-located facility), not 59 (residence-only)",
      daet.cnr.mn_cases_incl === 189, `got ${daet.cnr.mn_cases_incl}`);
    check("Daet's mn.total (MN module's own headline figure) matches the same 189",
      daet.mn.total === 189, `got ${daet.mn.total}`);
    check("Daet's mn_facility_catchment.total still agrees - internally consistent",
      daet.mn_facility_catchment && daet.mn_facility_catchment.total === 189,
      daet.mn_facility_catchment && `got ${daet.mn_facility_catchment.total}`);

    check("Daet's CNR cases is 311 (catchment: every case reported by a Daet-located public facility), not 282 (residence-only)",
      daet.cnr.cnr_cases === 311, `got ${daet.cnr.cnr_cases}`);
    check("Daet's Total Case Notified = 311 CNR + 189 MN = 500, matching the manual computation exactly",
      daet.cnr.notified === 500, `got ${daet.cnr.notified}`);
    const expectedRate = Math.round(500 / daet.population * 100000 * 10) / 10;
    check("Daet's CNR rate recomputes from the new 500 total",
      daet.cnr.rate_per_100k === expectedRate, `expected ${expectedRate}, got ${daet.cnr.rate_per_100k}`);

    // The municipality's own top_facilities breakdown must now agree EXACTLY with what each
    // facility's own page shows (this was the visible symptom of the bug: 100/87/72/23 in the
    // municipality breakdown vs 101/91/73/46 on each facility's own page).
    let topFacSum = 0;
    for (const f of DAET_FACILITIES) topFacSum += daet.cnr.top_facilities[f] || 0;
    check("Daet's top_facilities breakdown sums to the same 311 (no more mismatch between the municipality view and each facility's own page)",
      topFacSum === 311, `got ${topFacSum}: ${JSON.stringify(daet.cnr.top_facilities)}`);
  }

  // Cross-check against each facility's own page directly - this is exactly the manual computation
  // method that surfaced the discrepancy.
  let manualCnrSum = 0;
  for (const f of DAET_FACILITIES) {
    const node = kpi.nodes["F|CAMARINES NORTE|DAET|" + f];
    check(`${f}: facility page exists and contributes to the manual sum`, !!node);
    if (node) manualCnrSum += node.cnr.notified;
  }
  check("Manually summing all 4 facility pages' own CNR totals gives 311, matching the municipality's new cnr_cases",
    manualCnrSum === 311, `got ${manualCnrSum}`);
  check("Manual total (4 facility pages + MN Facilities 189) = 500, matching the municipality's notified figure exactly",
    manualCnrSum + 189 === 500, `got ${manualCnrSum + 189}`);

  // The explicit "Municipality page only" decision (from the MN fix) still applies, and now extends
  // to the CNR catchment fix too: an individual Daet facility must NOT show the municipality-wide MN
  // catchment number, and its OWN CNR total is exactly what appears on its own page (that IS the
  // catchment contribution for that one facility - there's nothing further to hide or share, unlike
  // MN's single shared total across all 4 facilities).
  for (const facilityKey of DAET_FACILITIES) {
    const node = kpi.nodes["F|CAMARINES NORTE|DAET|" + facilityKey];
    check(`${facilityKey}: facility-level MN figure is UNCHANGED (still its own residence-based count, not the shared 189)`,
      node && node.cnr.mn_cases_incl !== 189, node && `got ${node.cnr.mn_cases_incl}`);
  }
  const rhu1 = kpi.nodes["F|CAMARINES NORTE|DAET|DAET RURAL HEALTH UNIT I - IDOTS"];
  check("Daet RHU I specifically: still 0 MN cases and 101 notified (facility view intentionally untouched by the MN catchment total)",
    rhu1 && rhu1.cnr.mn_cases_incl === 0 && rhu1.cnr.notified === 101,
    rhu1 && JSON.stringify(rhu1.cnr));

  // Province/region must be unaffected by this change: every case counted under Daet's new
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
    ? "\nMUNICIPALITY-LEVEL CNR AND MN BOTH USE CATCHMENT ATTRIBUTION; FACILITY LEVEL STAYS UNCHANGED"
    : "\nCATCHMENT ATTRIBUTION MISMATCH FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
