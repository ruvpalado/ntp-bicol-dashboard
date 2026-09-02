// CNR denominators: which population figure each level of the hierarchy divides by.
//
// THE RULES:
//   1. every denominator comes from the uploaded workbook - the POPULATION sheet for region,
//      province and municipality, the POPULATION CATCHMENT sheet for individual facilities
//   2. where a municipality is served by more than one IDOTS/DOTS facility, each of those facilities
//      divides by its own catchment population, never by the whole municipality's
//   3. "more than one" counts IDOTS/DOTS facilities only. An MN private clinic or a PMDT unit in the
//      same town is not allocated a slice of the municipal population, so it must not trigger the
//      split - otherwise a facility that is the sole IDOTS provider loses its rate for no reason
//   4. a facility sharing a municipality with no catchment value published has no defensible
//      denominator, so its rate is withheld rather than published several times too low
//   5. none of this touches municipality, province or region totals, which divide their own summed
//      cases by their own population
const XLSX = require("xlsx");
const fs = require("fs");

// Region.xlsx retired in favor of Format.xlsx as the standard; test_fixtures_CamNorte.xlsx (real
// Camarines Norte case data + the current region-wide reference sheets) is its replacement.
const SRC = process.argv[2] || __dirname + "/test_fixtures_CamNorte.xlsx";
const { runPipelineOnBuffer } = require(__dirname + "/lib/pipeline");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);
const up = (s) => String(s === null || s === undefined ? "" : s).trim().toUpperCase();

if (!fs.existsSync(SRC)) { console.log("SKIP - source workbook unavailable"); process.exit(0); }

const buf = fs.readFileSync(SRC);
const cachePath = process.env.NTP_KPI_CACHE;
const kpi = cachePath && fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
  : runPipelineOnBuffer(buf);
const wb = XLSX.read(buf, { type: "buffer" });

const N = kpi.nodes, R = N.REGION;
const OPS = kpi.meta.operational_provinces;

// ---- what the uploaded sheets actually say ----
const catchment = {};
{
  const g = XLSX.utils.sheet_to_json(wb.Sheets["POPULATION CATCHMENT"], { header: 1 });
  // Header row location and FACILITY/POPULATION column positions are detected dynamically here,
  // mirroring how ntp_pipeline_browser.js reads this sheet - the layout is no longer a fixed
  // "2 header rows, facility in col 0, population in col 1" shape (that was the old Region.xlsx
  // layout). The current layout is Province/Municipality/Facility/Population with 1 header row.
  let facIdx = 2, popIdx = 3, headerIdx = 0;
  for (let i = 0; i < Math.min(5, g.length); i++) {
    const row = (g[i] || []).map(up);
    const fi = row.findIndex((c) => c.indexOf("FACILITY") !== -1);
    const pi = row.findIndex((c) => c.indexOf("POPULATION") !== -1);
    if (fi !== -1 && pi !== -1) { facIdx = fi; popIdx = pi; headerIdx = i; break; }
  }
  for (let i = headerIdx + 1; i < g.length; i++) {
    const r = g[i];
    if (!r || !r[facIdx]) continue;
    const v = Number(r[popIdx]);
    if (!isNaN(v) && v > 0) catchment[up(r[facIdx])] = v;
  }
}
check("the uploaded POPULATION CATCHMENT sheet was read",
  Object.keys(catchment).length > 0, Object.keys(catchment).length + " facilities");

// Facility List roster: either one combined "Facility List " sheet, or the newer layout that splits
// the same 4 columns across up to 5 sheets by Type (IDOTS/MN/PMDT/RTDL/TML), each row carrying its
// own Province directly - mirrors how ntp_pipeline_browser.js reads the roster.
function readRosterGrid(workbook) {
  if (workbook.Sheets["Facility List "]) return XLSX.utils.sheet_to_json(workbook.Sheets["Facility List "], { header: 1 });
  if (workbook.Sheets["Facility List"]) return XLSX.utils.sheet_to_json(workbook.Sheets["Facility List"], { header: 1 });
  const TYPE_SHEETS = ["IDOTS ", "IDOTS", "MN", "PMDT", "RTDL", "TML"];
  const seen = new Set();
  const combined = [];
  for (const name of TYPE_SHEETS) {
    const key = name.trim().toUpperCase();
    if (seen.has(key) || !workbook.Sheets[name]) continue;
    seen.add(key);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
    if (!combined.length) combined.push(rows[0] || []);
    combined.push(...rows.slice(1));
  }
  return combined;
}

const rosterType = {};
{
  const g = readRosterGrid(wb);
  const hdr = (g[0] || []).map(up);
  const iFac = hdr.findIndex((h) => h.indexOf("FACILITY") !== -1);
  const iType = hdr.findIndex((h) => h.indexOf("TYPE") !== -1);
  for (let i = 1; i < g.length; i++) {
    const r = g[i];
    if (!r || !r[iFac]) continue;
    rosterType[up(r[iFac])] = up(iType === -1 ? "" : r[iType]);
  }
}
const isIdots = (f) => rosterType[up(f)] === "IDOTS" || rosterType[up(f)] === "DOTS";
check("the roster carries a Type column to identify IDOTS/DOTS facilities",
  Object.values(rosterType).some((t) => t === "IDOTS" || t === "DOTS"),
  JSON.stringify(Object.keys(rosterType).length));

const popSheetRegion = (function () {
  const g = XLSX.utils.sheet_to_json(wb.Sheets.POPULATION, { header: 1 });
  for (const r of g) {
    if (!r) continue;
    if (up(r[0]).indexOf("REGION") === 0) {
      const v = Number(r[3]);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return null;
})();

// ================================================================ 1. denominators come from the upload
check("REGION divides by the population in the uploaded POPULATION sheet",
  popSheetRegion === null || Math.abs(R.population - popSheetRegion) < 1,
  `pipeline ${R.population} vs sheet ${popSheetRegion}`);
check("area populations sum to the regional population",
  Math.abs(OPS.reduce((a, p) => a + N["P|" + p].population, 0) - R.population) < 1);
check("REGION rate = its own cases / its own population",
  Math.abs(R.cnr.rate_per_100k - Math.round((R.cnr.notified / R.population) * 100000 * 10) / 10) < 0.11);

// ================================================================ 2. catchment values are applied
const facKeys = Object.keys(N).filter((k) => k.indexOf("F|") === 0);
const facByName = {};
for (const k of facKeys) facByName[up(k.split("|").slice(3).join("|"))] = k;

let applied = 0, missingNode = 0;
for (const name in catchment) {
  const key = facByName[name];
  if (!key) { missingNode++; continue; }
  const n = N[key];
  check(`${name.slice(0, 44)}: uses its own catchment population`,
    n.population !== null && Math.abs(n.population - catchment[name]) < 1,
    `node ${n.population} vs sheet ${catchment[name]}`);
  if (n.population !== null && Math.abs(n.population - catchment[name]) < 1) applied++;
  if (n.cnr && n.cnr.notified > 0) {
    check(`${name.slice(0, 44)}: rate = its cases / its catchment`,
      n.cnr.rate_per_100k !== null &&
        Math.abs(n.cnr.rate_per_100k - Math.round((n.cnr.notified / catchment[name]) * 100000 * 10) / 10) < 0.11,
      `${n.cnr.rate_per_100k}`);
  }
}
check("every catchment facility in the sheet resolved to a node",
  missingNode === 0, `${missingNode} not found among ${facKeys.length} facility nodes`);

// A catchment facility must never SILENTLY fall back to its municipality's population - that is
// the exact error the sheet exists to prevent. This is checked by provenance (does the node's
// population match what the catchment sheet itself says, already verified above as "uses its own
// catchment population"), not by value-inequality against the municipality: a facility can
// legitimately have an explicit override that numerically equals the whole municipality (e.g. a
// single city-wide PPMD unit deliberately assigned the full city population) without that being a
// fallback bug. Checking inequality here would just be re-deriving the same signal the direct
// provenance check above already gets right, and would flag that legitimate case as a false
// failure - so this only checks facilities where the sheet's own value actually differs from the
// municipality's, i.e. cases where equality really would indicate an unintended fallback.
for (const name in catchment) {
  const key = facByName[name];
  if (!key) continue;
  const parts = key.split("|");
  const muni = N["M|" + parts[1] + "|" + parts[2]];
  if (!muni || !muni.population) continue;
  if (Math.abs(catchment[name] - muni.population) < 1) continue; // sheet itself says they're equal - not a fallback signal
  check(`${name.slice(0, 44)}: denominator is not the whole municipality`,
    Math.abs(N[key].population - muni.population) > 1,
    `facility ${N[key].population} equals municipality ${muni.population}`);
}

// ================================================================ 3. the split is IDOTS/DOTS-only
// Group facilities by municipality and confirm the rule was applied on the right basis.
const byMuni = {};
for (const k of facKeys) {
  const p = k.split("|");
  (byMuni[p[1] + "|" + p[2]] = byMuni[p[1] + "|" + p[2]] || []).push(k);
}
let multiIdotsMunis = 0, nonIdotsWronglySuppressed = 0, soleIdotsSuppressed = 0;
for (const mk in byMuni) {
  const activeIdots = byMuni[mk].filter((k) =>
    N[k].cnr && N[k].cnr.notified > 0 && isIdots(k.split("|").slice(3).join("|")));
  if (activeIdots.length >= 2) multiIdotsMunis++;
  for (const k of byMuni[mk]) {
    const n = N[k];
    const suppressed = n.cnr && n.cnr.population_basis === "catchment_missing";
    if (!suppressed) continue;
    // Anything suppressed must sit in a municipality with 2+ active IDOTS/DOTS facilities.
    if (activeIdots.length < 2) soleIdotsSuppressed++;
    // And a private MN clinic must never be the thing that got suppressed.
    const t = rosterType[up(k.split("|").slice(3).join("|"))];
    if (t === "MN" || t === "NOT ENGAGED") nonIdotsWronglySuppressed++;
  }
}
check("municipalities served by more than one IDOTS/DOTS facility exist in this data",
  multiIdotsMunis > 0, `${multiIdotsMunis} - if zero this test proves nothing`);
check("no facility is suppressed where it is the only active IDOTS/DOTS provider",
  soleIdotsSuppressed === 0, `${soleIdotsSuppressed} wrongly suppressed`);
check("private MN / Not-Engaged sites never trigger or suffer the catchment split",
  nonIdotsWronglySuppressed === 0, `${nonIdotsWronglySuppressed} non-IDOTS facilities suppressed`);

// ================================================================ 4. gaps are withheld, not guessed
const suppressed = facKeys.filter((k) => N[k].cnr && N[k].cnr.population_basis === "catchment_missing");
for (const k of suppressed) {
  check(`${k.split("|").slice(3).join("|").slice(0, 40)}: rate withheld rather than published wrong`,
    N[k].population === null && N[k].cnr.rate_per_100k === null,
    `pop ${N[k].population}, rate ${N[k].cnr.rate_per_100k}`);
}
if (suppressed.length) {
  const issues = (kpi.meta.data_quality_issues || []).join(" ");
  check("the missing catchment values are reported as a data-quality issue",
    /POPULATION CATCHMENT is incomplete/.test(issues));
}

// ================================================================ 5. totals are untouched
// The facility denominators must not leak upward: a municipality divides by its own population.
let muniChecked = 0;
for (const k of Object.keys(N).filter((x) => x.indexOf("M|") === 0)) {
  const n = N[k];
  if (!n.cnr || !n.cnr.notified || !n.population) continue;
  const exp = Math.round((n.cnr.notified / n.population) * 100000 * 10) / 10;
  if (Math.abs(n.cnr.rate_per_100k - exp) < 0.11) muniChecked++;
  else check(`${k}: municipality rate = its cases / its own population`, false,
    `${n.cnr.rate_per_100k} vs ${exp}`);
}
check("every municipality divides by its own population", muniChecked > 0, `${muniChecked} checked`);
for (const p of OPS) {
  const n = N["P|" + p];
  if (!n.cnr || !n.cnr.notified || !n.population) continue;
  check(`${p}: province rate unaffected by facility denominators`,
    Math.abs(n.cnr.rate_per_100k - Math.round((n.cnr.notified / n.population) * 100000 * 10) / 10) < 0.11,
    String(n.cnr.rate_per_100k));
}
check("REGION notified still equals the sum of the seven areas",
  R.cnr.notified === OPS.reduce((a, p) => a + N["P|" + p].cnr.notified, 0));

const pass = results.filter((r) => r[1]).length;
const fail = results.filter((r) => !r[1]);
for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
console.log("\n" + "=".repeat(70));
console.log(`TOTAL: ${pass}/${results.length} passed   (${applied} catchment values applied)`);
console.log(fail.length === 0 ? "\nCNR DENOMINATORS ARE CORRECT" : "\nDENOMINATOR ISSUES FOUND");
process.exitCode = fail.length === 0 ? 0 : 1;
