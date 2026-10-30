// Verifies the barangay-level CNR breakdown attached to facility nodes:
//   * every facility node gets rows for its municipality (including zero-case barangays)
//   * each row's rate is cases / barangay population * 100,000
//   * cases + outside-municipality + unspecified reconciles to the facility's CNR+MN total
const fs = require("fs");
const path = require("path");
const pipeline = require("./lib/pipeline");

const results = [];
const check = (name, ok, detail) => results.push([name, !!ok, ok ? "" : (detail || "")]);

const src = path.join(__dirname, "test_fixtures_CamNorte.xlsx");
if (!fs.existsSync(src)) {
  console.log("SKIP - fixture unavailable");
  process.exit(0);
}

const kpi = pipeline.runPipelineOnBuffer(fs.readFileSync(src));
const nodes = kpi.nodes || {};

const facilityKeys = Object.keys(nodes).filter((k) => k.startsWith("F|"));
const facilityNodes = facilityKeys.map((k) => ({ key: k, node: nodes[k] }));
const withRows = facilityNodes.filter((x) => Array.isArray(x.node.cnr.barangays) && x.node.cnr.barangays.length > 0);
check("every facility node carries barangay rows", withRows.length === facilityNodes.length, `${withRows.length}/${facilityNodes.length}`);

const paracale = nodes["F|CAMARINES NORTE|PARACALE|PARACALE RURAL HEALTH UNIT I - IDOTS"];
check("Paracale facility node exists", !!paracale);
if (paracale) {
  const rows = paracale.cnr.barangays;
  const sum = rows.reduce((s, r) => s + r.cases, 0);
  const outside = paracale.cnr.barangay_outside_cases || 0;
  const unspecified = paracale.cnr.barangay_unspecified_cases || 0;
  check("Paracale barangay cases reconcile to notified", sum + outside + unspecified === paracale.cnr.notified,
    `${sum}+${outside}+${unspecified} vs ${paracale.cnr.notified}`);
  check("Paracale table includes zero-case barangays", rows.some((r) => r.cases === 0));
  check("Paracale rows all have population and valid rate", rows.every((r) =>
    r.population > 0 && r.rate_per_100k === Math.round(r.cases / r.population * 100000 * 10) / 10));
  check("Paracale rows are sorted by cases descending", rows.every((r, i) => i === 0 || rows[i - 1].cases >= r.cases));
}

const naga = nodes["F|NAGA CITY|NAGA CITY|BICOL MEDICAL CENTER"];
check("Naga facility resolves barangays from parent province", !!(naga && naga.cnr.barangays && naga.cnr.barangays.length > 0),
  naga ? String(naga.cnr.barangays && naga.cnr.barangays.length) : "missing");
if (naga && naga.cnr.barangays) {
  check("Naga barangays have population", naga.cnr.barangays.every((r) => r.population > 0));
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log((ok ? "PASS" : "FAIL") + " - " + name + (ok ? "" : "\n         " + detail));
  if (!ok) failed++;
}
console.log("\nTOTAL: " + (results.length - failed) + "/" + results.length + " passed");
process.exit(failed ? 1 : 0);
