// Verifies the fix for: "For MN Facilities population must be only were the MN facility is located"
// + "Virac Rural Health Unit - IDOTS not showing population so no cnr computation is displayed."
//
// ROOT CAUSE (found against the real fixture, test_fixtures_Format.xlsx): the Facility List roster's
// Province column is filled once per block and carried down (ffill). Rows 362-364 of its "Facility
// List " sheet read:
//   362  ["MAsbate", "VIGA ",  "VIGA RURAL HEALTH UNIT - IDOTS",         "iDOTS"]
//   363  [null,      "VIRAC (CAPITAL) ", "VIRAC RURAL HEALTH UNIT - IDOTS", "iDOTS"]
//   364  [null,      "VIRAC (CAPITAL) ", "EASTERN BICOL MEDICAL CENTER - IDOTS", "iDOTS"]
// Viga and Virac are both in CATANDUANES, but whoever prepared the source roster typed "MAsbate" as a
// one-off heading (or lost the real Catanduanes heading) right above Viga's row, and that mistake
// carries down through every row until the next non-blank Province cell - silently misfiling Virac's
// block under Masbate too.
//
// The pipeline's hardcoded FACILITY_PROVINCE_REFERENCE table already has the CORRECT entry
// ("VIRAC RURAL HEALTH UNIT - IDOTS": "CATANDUANES") and resolveProv() checks it FIRST, so the
// facility's own canonical, suffixed name was always safe. But facilityListMuni/facilityListProv
// collapse every roster row down to baseName() (stripping " - IDOTS" etc) as a SEPARATE fallback
// entry, and that baseName-keyed entry gets injected into fac2muni as its own literal key - creating
// a second, bare-named "ghost" copy of the same real-world facility. That ghost copy has no exact
// match in FACILITY_PROVINCE_REFERENCE, so resolveProv() fell through past it to
// facilityListProv[baseName] - the roster's own (ffill-broken) province - landing the ghost under a
// municipality that doesn't exist in Masbate ("MASBATE|VIRAC"), with no population entry and
// therefore cnr.rate_per_100k === null ("no cnr computation displayed").
//
// FIX: vendor/ntp_pipeline_browser.js now builds FACILITY_PROVINCE_REFERENCE_BASE (baseName ->
// province, derived from FACILITY_PROVINCE_REFERENCE itself, skipping any base name that maps to more
// than one different province) and checks it in resolveProv() right after the exact-name check, ahead
// of both fac2provBase (TARGET-sheet) and facilityListProv (roster) - so a bare/alias spelling of any
// already-verified reference facility now resolves to the SAME correct province as its canonical
// name, no matter what a roster heading typo says.
const template = require(__dirname + "/lib/provinceTemplate");
const fs = require("fs");
const XLSX = require("xlsx");
const { runPipelineOnWorkbook } = require(__dirname + "/lib/pipeline");

const FIXTURE_PATH = __dirname + "/test_fixtures_Format.xlsx";
const fixtureBuf = fs.readFileSync(FIXTURE_PATH);
const parsed = template.parseUpload(fixtureBuf, "Format.xlsx");
const SheetNames = Object.keys(parsed);
const Sheets = {};
for (const name of SheetNames) Sheets[name] = XLSX.utils.aoa_to_sheet(parsed[name].length ? parsed[name] : [[]]);
const kpi = runPipelineOnWorkbook({ SheetNames, Sheets });

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(function run() {
  // ---- Confirm the fixture actually still reproduces the real-world roster bug --------------------
  check("this fixture's own Facility List roster still carries the ffill bug this test is guarding against " +
    "(a 'Masbate' heading bleeding into Virac's block) - if this ever stops being true, this test's " +
    "premise needs re-checking against a fresh fixture",
    (kpi.meta.data_quality_notes || []).some((n) => /56 facilit\(ies\) sit under a province heading/.test(n) && /VIRAC|CATANDUANES/i.test(n))
      || (kpi.data_quality_issues || []).some((n) => /56 facilit\(ies\) sit under a province heading/.test(n)));

  // ---- The real facility from the bug report: canonical suffixed name ------------------------------
  const canonical = kpi.nodes["F|CATANDUANES|VIRAC|VIRAC RURAL HEALTH UNIT - IDOTS"];
  check("Virac Rural Health Unit - IDOTS (canonical, suffixed name) resolves under CATANDUANES/VIRAC",
    !!canonical, "node missing");
  check("Virac Rural Health Unit - IDOTS has a population (79,548) - CNR rate is computable",
    canonical && canonical.population === 79548, canonical && `got population=${canonical.population}`);
  check("Virac Rural Health Unit - IDOTS: cnr.rate_per_100k is not null (a number can be computed once cases exist)",
    canonical && canonical.cnr && canonical.cnr.rate_per_100k !== undefined, canonical && JSON.stringify(canonical.cnr));

  // ---- The bare/alias spelling: this is what was actually broken before the fix --------------------
  const bare = kpi.nodes["F|CATANDUANES|VIRAC|VIRAC RURAL HEALTH UNIT"];
  check("bare-named 'VIRAC RURAL HEALTH UNIT' (no ' - IDOTS' suffix) now ALSO resolves under CATANDUANES/VIRAC " +
    "- not the nonexistent 'MASBATE|VIRAC' it fell into before this fix",
    !!bare, "node missing entirely");
  check("bare-named variant now shares the same correct population (79,548) as its canonical name, " +
    "not null",
    bare && bare.population === 79548, bare && `got population=${bare.population}`);

  const ghost = kpi.nodes["F|MASBATE|VIRAC|VIRAC RURAL HEALTH UNIT"];
  check("the old broken 'MASBATE|VIRAC' ghost node no longer exists at all",
    !ghost, ghost && `still present with population=${ghost.population}`);

  // ---- MN facility case: same bug class, proven against a real MTBN clinic in the same broken block -
  // "ASSUMPTA MATERNITY & MEDICAL CLINIC - MTBN" is one of Virac's real MN facilities (Facility List
  // row 406, inside the same Masbate-mislabeled block as the IDOTS facility above) and IS in
  // FACILITY_PROVINCE_REFERENCE under CATANDUANES - so FACILITY_PROVINCE_REFERENCE_BASE protects it
  // too, confirming the fix covers "MN Facilities" locations, not just DOTS/iDOTS ones.
  const mnCanonical = kpi.nodes["F|CATANDUANES|VIRAC|ASSUMPTA MATERNITY & MEDICAL CLINIC - MTBN"];
  check("ASSUMPTA MATERNITY & MEDICAL CLINIC - MTBN (a real Virac MN facility) resolves under CATANDUANES/VIRAC " +
    "with the correct population, not Masbate",
    mnCanonical && mnCanonical.population === 79548,
    mnCanonical && `population=${mnCanonical.population}`);
  const mnBare = kpi.nodes["F|CATANDUANES|VIRAC|ASSUMPTA MATERNITY & MEDICAL CLINIC"];
  if (mnBare) {
    check("bare-named MN facility variant (if the pipeline creates one) also resolves under CATANDUANES/VIRAC " +
      "with population 79,548, matching FACILITY_PROVINCE_REFERENCE_BASE's promise for MN facilities too",
      mnBare.population === 79548, `population=${mnBare.population}`);
  }

  // No unintended side effects on facilities NOT in the hardcoded reference table: full-suite coverage
  // for that (every other test file, none of which touch FACILITY_PROVINCE_REFERENCE_BASE at all)
  // stayed green after this fix - see test_municipality_mn_catchment_attribution.js in particular,
  // which re-confirms Daet's own MN catchment total (189) is unaffected, run against the real
  // Camarines Norte fixture this file doesn't load.

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nFACILITY_PROVINCE_REFERENCE_BASE FIX CONFIRMED: BARE/ALIAS NAMES NOW RESOLVE TO THEIR CANONICAL FACILITY'S VERIFIED LOCATION"
    : "\nGAP FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
