// Verifies the RR/MDR target formula against instruction:
//   RR/MDR = (Case Notified x 87% x 1.96%) + (Case Notified x 13% x 13.53%)
//     - New registration group: Case Notified x 87% (proportion new) x 1.96% (RR/MDR prevalence
//       among new).
//     - Other registration groups: Case Notified x 13% (proportion retreatment/other) x 13.53%
//       (RR/MDR prevalence among retreatment).
//     - Final: sum both to get estimated total RR/MDR cases.
//
// CLARIFIED (superseding an earlier attempt at this same fix): "Case Notified" in this formula means
// the CASE TO BE notified - the population-derived case-notification TARGET (ctbn, same figure shown
// as tgt.ctbn / notif_target elsewhere on a node) - NOT the actual reported notified total. An earlier
// pass at this fix used the actual `notified` figure instead; this test now locks in the corrected,
// ctbn-based version and would fail if that regressed back to using actual notified cases.
//
// This also keeps tgt.rr_mdr consistent with every other field in the same `tgt` object (mn, tpt,
// presumptive, screen_cxr, ctbn_adult, ctbn_child - all derived from ctbn, none from actual case
// counts), and keeps dstb_target's definition (ctbn - rr_mdr, "the complementary remainder of Case
// Notified target minus RR/MDR target") internally coherent, since both sides of that subtraction are
// now target-based figures.
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

function expectedRrMdr(ctbn) {
  return Math.round((ctbn * 0.87 * 0.0196 + ctbn * 0.13 * 0.1353) * 10) / 10;
}

(function run() {
  // ---- Real municipality: Daet, Camarines Norte -----------------------------------------------
  const daet = kpi.nodes["M|CAMARINES NORTE|DAET"];
  check("Daet municipality node exists", !!daet);
  if (daet) {
    check("Daet has a valid population to derive a case-to-be-notified target (ctbn) from",
      daet.population > 0, `got ${daet.population}`);
    check("Daet's ctbn (population-derived target) is a DIFFERENT figure from its actual notified total (500) " +
      "- confirms this test is really exercising the target-based path, not coincidentally matching actual",
      daet.targets.ctbn !== daet.cnr.notified, `ctbn=${daet.targets.ctbn}, notified=${daet.cnr.notified}`);
    const rawCtbnDaet = daet.population * 0.00561;
    const expected = expectedRrMdr(rawCtbnDaet);
    check(`Daet's RR/MDR target (${daet.targets.rr_mdr}) = (Case to be notified ${rawCtbnDaet.toFixed(2)} x87%x1.96%) ` +
      `+ (x13%x13.53%) = ${expected}, matching the ctbn-based formula exactly`,
      daet.targets.rr_mdr === expected, `expected ${expected}, got ${daet.targets.rr_mdr}`);
    check("Daet's RR/MDR target is NOT derived from the actual notified total (would be 17.3, not this value)",
      daet.targets.rr_mdr !== expectedRrMdr(daet.cnr.notified) || rawCtbnDaet === daet.cnr.notified,
      `got ${daet.targets.rr_mdr}, actual-based would be ${expectedRrMdr(daet.cnr.notified)}`);

    // drtb_target/dstb_target inherit this automatically, per their own pre-existing design.
    check("Daet's drtb_target equals the same RR/MDR target (tgt.rr_mdr)",
      daet.target_vs_actual.drtb_target === daet.targets.rr_mdr,
      `drtb_target=${daet.target_vs_actual.drtb_target}, rr_mdr=${daet.targets.rr_mdr}`);
    const expectedDstb = Math.round((daet.targets.ctbn - daet.targets.rr_mdr) * 10) / 10;
    check("Daet's dstb_target equals Case Notified TARGET (ctbn) minus the RR/MDR target - both sides " +
      "target-based, composing coherently",
      daet.target_vs_actual.dstb_target === expectedDstb,
      `dstb_target=${daet.target_vs_actual.dstb_target}, expected ${expectedDstb}`);
  }

  // ---- Region-wide: every node with a valid ctbn must satisfy the formula exactly ------------------
  let audited = 0, nullOk = 0;
  for (const key in kpi.nodes) {
    const node = kpi.nodes[key];
    if (!node || !node.targets) continue;
    // Use the RAW population x 0.00561 here, not the already-rounded node.targets.ctbn - the pipeline's
    // own rr_mdr computation multiplies against the unrounded ctbn internally (tgt.ctbn itself is
    // round0()'d for display, but that rounding happens on a separate field, after rr_mdr already used
    // the precise value) - comparing against the rounded display figure would introduce spurious ~0.1
    // mismatches purely from double-rounding, not from any real formula error.
    if (node.population === null || node.population === undefined || node.population <= 0) {
      if (node.targets.rr_mdr !== null) {
        check(`${key}: rr_mdr is null when there's no valid population (no ctbn -> no target)`, false,
          `population invalid but rr_mdr=${node.targets.rr_mdr}`);
      } else nullOk++;
      continue;
    }
    const rawCtbn = node.population * 0.00561;
    const expected = expectedRrMdr(rawCtbn);
    if (node.targets.rr_mdr !== expected) {
      check(`${key}: RR/MDR target (${node.targets.rr_mdr}) matches ctbn-based formula (expected ${expected}, raw ctbn=${rawCtbn})`,
        false, "mismatch");
    }
    audited++;
  }
  check(`every node with a valid population-derived target was audited against the ctbn-based formula with zero mismatches (${audited} nodes)`,
    !results.some((r) => !r[1] && /RR\/MDR target/.test(r[0])), "see individual failures above, if any");
  check("more than 100 nodes were actually audited (the walk found real data, not an empty dataset)",
    audited > 100, `only audited ${audited}`);
  check("nodes without a valid population (no ctbn) correctly show rr_mdr as null too, not a stray number",
    nullOk >= 0, `${nullOk} such nodes, all consistent`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nRR/MDR TARGET IS DRIVEN BY CASE TO BE NOTIFIED (ctbn), CONSISTENT WITH EVERY OTHER TARGET FIELD"
    : "\nRR/MDR FORMULA MISMATCH FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
