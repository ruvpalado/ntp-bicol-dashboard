// Verifies the RR/MDR target formula against instruction:
//   RR/MDR = (Case Notified x 87% x 1.96%) + (Case Notified x 13% x 13.53%)
//     - New registration group: Case Notified x 87% (proportion new) x 1.96% (RR/MDR prevalence
//       among new).
//     - Other registration groups: Case Notified x 13% (proportion retreatment/other) x 13.53%
//       (RR/MDR prevalence among retreatment).
//     - Final: sum both to get estimated total RR/MDR cases.
//
// BUG FOUND: the dashboard's own Targets table (vendor/dashboard_js_full.txt) already labeled the
// RR/MDR row with this exact formula text - "(Case Notified x87%x1.96%) + (Case Notified
// x13%x13.53%)" - but the underlying computation (vendor/ntp_pipeline_browser.js, tgt.rr_mdr) actually
// multiplied by `ctbn` (population x 0.00561, the SEPARATE population-derived case-notification
// target used by every other row in the Targets table) instead of by the real notified total. The
// on-screen label never matched what the number actually was, and RR/MDR came out null whenever
// population was missing even if real cases had been notified (RR/MDR does not need a population to
// compute - it is a share of cases already on the books).
//
// FIX: tgt.rr_mdr now multiplies `notified` (the same New/Relapse CNR + New/Relapse MN total already
// shown as "Case Notified" everywhere else on a node) by the 87%/1.96% and 13%/13.53% factors
// directly, with no population dependency. DSTB/DRTB targets (drtb_target = tgt.rr_mdr, dstb_target =
// tgt.ctbn - tgt.rr_mdr) automatically follow, per their own pre-existing, already-documented design.
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

function expectedRrMdr(notified) {
  return Math.round((notified * 0.87 * 0.0196 + notified * 0.13 * 0.1353) * 10) / 10;
}

(function run() {
  // ---- Real municipality: Daet, Camarines Norte (500 notified per the CNR catchment fix) ---------
  const daet = kpi.nodes["M|CAMARINES NORTE|DAET"];
  check("Daet municipality node exists", !!daet);
  if (daet) {
    check("Daet's Case Notified (notified) is a real, nonzero figure to test the formula against",
      daet.cnr.notified > 0, `got ${daet.cnr.notified}`);
    const expected = expectedRrMdr(daet.cnr.notified);
    check(`Daet's RR/MDR target (${daet.targets.rr_mdr}) = (Case Notified ${daet.cnr.notified} x87%x1.96%) ` +
      `+ (x13%x13.53%) = ${expected}, matching the formula exactly (not the old population-based ctbn figure)`,
      daet.targets.rr_mdr === expected, `expected ${expected}, got ${daet.targets.rr_mdr}`);
    check("Daet's RR/MDR target is NOT the same as ctbn x the RR/MDR rates (the old, wrong basis) " +
      "unless notified and ctbn happen to coincide - confirms the formula actually switched inputs",
      daet.targets.ctbn !== daet.cnr.notified ? daet.targets.rr_mdr !== expectedRrMdr(daet.targets.ctbn) || daet.targets.ctbn === daet.cnr.notified : true,
      `ctbn=${daet.targets.ctbn}, notified=${daet.cnr.notified}`);

    // drtb_target/dstb_target inherit this automatically, per their own pre-existing design.
    check("Daet's drtb_target equals the same RR/MDR target (tgt.rr_mdr), per the existing 'DRTB target " +
      "reuses the RR/MDR formula target' design",
      daet.target_vs_actual.drtb_target === daet.targets.rr_mdr,
      `drtb_target=${daet.target_vs_actual.drtb_target}, rr_mdr=${daet.targets.rr_mdr}`);
    const expectedDstb = Math.round((daet.targets.ctbn - daet.targets.rr_mdr) * 10) / 10;
    check("Daet's dstb_target equals Case Notified TARGET (ctbn, population-based) minus the now-fixed " +
      "RR/MDR target, per the existing 'DSTB target is the complementary remainder' design",
      daet.target_vs_actual.dstb_target === expectedDstb,
      `dstb_target=${daet.target_vs_actual.dstb_target}, expected ${expectedDstb}`);
  }

  // ---- Region-wide: every municipality/province/region node with notified > 0 must satisfy the ----
  // formula exactly, and rr_mdr must never be null now (it no longer depends on population).
  let audited = 0;
  for (const key in kpi.nodes) {
    const node = kpi.nodes[key];
    if (!node || !node.cnr || !node.targets) continue;
    const notified = node.cnr.notified;
    const expected = expectedRrMdr(notified);
    if (node.targets.rr_mdr !== expected) {
      check(`${key}: RR/MDR target (${node.targets.rr_mdr}) matches Case Notified formula (expected ${expected}, notified=${notified})`,
        false, `mismatch`);
    }
    audited++;
  }
  check(`every node with a targets object was audited against the Case Notified formula with zero mismatches (${audited} nodes)`,
    !results.some((r) => !r[1] && /RR\/MDR target/.test(r[0])), "see individual failures above, if any");

  check("more than 100 nodes were actually audited (the walk found real data, not an empty dataset)",
    audited > 100, `only audited ${audited}`);

  // rr_mdr must never be null anywhere now, including for a facility/area with population === null
  // (it used to be null there, since it depended on ctbn which requires a valid population).
  const nullRrMdr = Object.keys(kpi.nodes).filter((k) => kpi.nodes[k].targets && kpi.nodes[k].targets.rr_mdr === null);
  check("no node's RR/MDR target is null (it no longer depends on population being available at all)",
    nullRrMdr.length === 0, `${nullRrMdr.length} node(s) still null: ${nullRrMdr.slice(0, 5).join(", ")}`);

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0
    ? "\nRR/MDR TARGET NOW MATCHES ITS OWN DOCUMENTED FORMULA, DRIVEN BY CASE NOTIFIED, EVERYWHERE"
    : "\nRR/MDR FORMULA MISMATCH FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
