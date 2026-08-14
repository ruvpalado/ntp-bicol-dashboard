// CNR attribution: which area a patient record counts towards, and whether the region adds up.
//
// THE RULE: a record is assigned to the province of the FACILITY it was recorded to, never to the
// patient's residential address. The uploaded "Facility List " roster is the authority for where
// each facility sits; the built-in reference covers facilities the roster omits.
//
// A consequence to keep in view when reading the dashboard: an area hosting a regional referral
// hospital carries the caseload that hospital diagnoses, drawn from across Bicol. Its notification
// rate reflects facility throughput, not local incidence.
//
// The roster is a single point of failure, so these checks also cover what happens when it is
// wrong: its Province cell is filled once per block and carried down, so a heading that is missing
// or typed one row late silently absorbs every facility beneath it into the wrong province.
const XLSX = require("xlsx");
const fs = require("fs");

// Region.xlsx retired in favor of Format.xlsx as the standard; test_fixtures_CamNorte.xlsx (real
// Camarines Norte case data + the current region-wide reference sheets) is its replacement.
const SRC = process.argv[2] || __dirname + "/test_fixtures_CamNorte.xlsx";
const { runPipelineOnBuffer } = require(__dirname + "/lib/pipeline");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);
const norm = (s) => String(s === null || s === undefined ? "" : s)
  .trim().toUpperCase().replace(/\s*\([^)]*\)\s*$/, "").trim();

if (!fs.existsSync(SRC)) { console.log("SKIP - source workbook unavailable"); process.exit(0); }

const buf = fs.readFileSync(SRC);
// Pipeline + a full workbook re-read overruns a short test budget, so a computed dataset can be
// supplied with NTP_KPI_CACHE=<path>. Without it the test computes the dataset itself.
const cachePath = process.env.NTP_KPI_CACHE;
const kpi = cachePath && fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
  : runPipelineOnBuffer(buf);
const wb = XLSX.read(buf, { type: "buffer" });

// Facility List roster: either one combined "Facility List " sheet, or the newer layout that splits
// the same 4 columns across up to 5 sheets by Type (IDOTS/MN/PMDT/RTDL/TML), each row carrying its
// own Province directly - mirrors how ntp_pipeline_browser.js reads the roster (see its "Two
// supported layouts" comment).
function readRosterGrid(wb) {
  if (wb.Sheets["Facility List "]) return XLSX.utils.sheet_to_json(wb.Sheets["Facility List "], { header: 1 });
  if (wb.Sheets["Facility List"]) return XLSX.utils.sheet_to_json(wb.Sheets["Facility List"], { header: 1 });
  const TYPE_SHEETS = ["IDOTS ", "IDOTS", "MN", "PMDT", "RTDL", "TML"];
  const seen = new Set();
  const combined = [];
  for (const name of TYPE_SHEETS) {
    const key = name.trim().toUpperCase();
    if (seen.has(key) || !wb.Sheets[name]) continue;
    seen.add(key);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
    if (!combined.length) combined.push(rows[0] || []);
    combined.push(...rows.slice(1));
  }
  return combined;
}

// The CNR sheet is padded out to Excel's row limit, so parsing it is expensive - each sheet is
// converted exactly once here and every check below reuses these grids.
const GRID = {
  cnr: XLSX.utils.sheet_to_json(wb.Sheets["CNR 2026 "], { header: 1 }),
  mn: XLSX.utils.sheet_to_json(wb.Sheets["MN 2026"], { header: 1 }),
  roster: readRosterGrid(wb),
  pop: XLSX.utils.sheet_to_json(wb.Sheets.POPULATION, { header: 1 }),
};

const OPS = kpi.meta.operational_provinces;
const N = kpi.nodes, R = N.REGION;
const NR = new Set(["NEW", "RELAPSE"]);

// ---- the roster, read exactly as the pipeline reads it (Province forward-filled) ----
const rosterProv = {};
const rosterAreas = {};
{
  const g = GRID.roster;
  const hdr = (g[0] || []).map((h) => norm(h));
  const iProv = hdr.findIndex((h) => h.indexOf("PROVINCE") === 0);
  const iMuni = hdr.findIndex((h) => h.indexOf("MUNICIPAL") !== -1 || h.indexOf("CITY") !== -1);
  const iFac = hdr.findIndex((h) => h.indexOf("FACILITY") !== -1);
  let block = null;
  for (let i = 1; i < g.length; i++) {
    const r = g[i];
    if (!r) continue;
    const p = norm(r[iProv]);
    if (p) block = p;
    const f = norm(r[iFac]);
    if (!f || !block) continue;
    // Mirror the pipeline: an area the dashboard reports at province level can appear in the roster
    // as a MUNICIPALITY of its parent (Naga City under Camarines Sur). Its population is carved out
    // of the parent's, so its cases are too, and the municipality decides the area.
    const muni = iMuni === -1 ? "" : norm(r[iMuni]);
    const area = OPS.indexOf(muni) !== -1 ? muni : block;
    rosterProv[f] = area;
    rosterAreas[area] = (rosterAreas[area] || 0) + 1;
  }
}
check("the Facility List roster was read", Object.keys(rosterProv).length > 100,
  Object.keys(rosterProv).length + " facilities");

// ================================================================ 1. the region adds up
const sumAreas = OPS.reduce((a, p) => a + ((N["P|" + p] && N["P|" + p].cnr.notified) || 0), 0);
check("REGION notified = sum of the seven areas, exactly",
  R.cnr.notified === sumAreas, `region ${R.cnr.notified} vs sum ${sumAreas}`);
check("the CNR-sheet component sums exactly",
  R.cnr.cnr_cases === OPS.reduce((a, p) => a + N["P|" + p].cnr.cnr_cases, 0));
check("the MN component sums exactly",
  R.cnr.mn_cases_incl === OPS.reduce((a, p) => a + N["P|" + p].cnr.mn_cases_incl, 0));
check("notified = CNR component + MN component at region level",
  R.cnr.notified === R.cnr.cnr_cases + R.cnr.mn_cases_incl);
check("area populations sum to the regional population",
  Math.abs(OPS.reduce((a, p) => a + N["P|" + p].population, 0) - R.population) < 1);
check("REGION rate = summed cases / summed population",
  Math.abs(R.cnr.rate_per_100k - Math.round((R.cnr.notified / R.population) * 100000 * 10) / 10) < 0.11);

// ================================================================ 2. attribution follows the facility
// Recompute each area's caseload straight from the roster and the two line lists. This is the whole
// rule in four lines, and it must reproduce the pipeline exactly.
//
// Column positions are found BY NAME, not hardcoded index: CNR/MN column layouts are name-based in
// the real pipeline (ntp_pipeline_browser.js reads via objRows, keyed by header text), and a fixed
// index silently drifts whenever a column is inserted - which is exactly what happened when "Treatment
// Health Facility" was added to MN 2026 this session, shifting every later column over by one. The
// attribution facility is always "Screening/Diagnosing Health Facility" (who diagnosed the case),
// never "Treatment Health Facility" (where they're being treated) - the two are deliberately excluded
// from each other here since both contain the substring "FACILITY".
function findCol(header, mustInclude, mustExclude) {
  const hdr = (header || []).map((h) => norm(h));
  for (let i = 0; i < hdr.length; i++) {
    const h = hdr[i];
    if (mustInclude.every((m) => h.indexOf(m) !== -1) && !(mustExclude || []).some((m) => h.indexOf(m) !== -1)) return i;
  }
  return -1;
}
function tallyByFacility(grid) {
  const g = grid;
  const iFac = findCol(g[0], ["FACILITY"], ["TREATMENT"]);
  const iReg = findCol(g[0], ["REGISTRATION"]);
  const t = {};
  let unmapped = 0;
  for (let i = 1; i < g.length; i++) {
    const r = g[i];
    if (!r) continue;
    if (!NR.has(norm(r[iReg]))) continue;
    const area = rosterProv[norm(r[iFac])];
    if (area) t[area] = (t[area] || 0) + 1;
    else unmapped++;
  }
  return { t, unmapped };
}
const fc = tallyByFacility(GRID.cnr);
const fm = tallyByFacility(GRID.mn);
const byFacility = {};
for (const src of [fc.t, fm.t]) for (const a in src) byFacility[a] = (byFacility[a] || 0) + src[a];
const unmapped = fc.unmapped + fm.unmapped;

for (const p of OPS) {
  const got = N["P|" + p].cnr.notified;
  const want = byFacility[p] || 0;
  check(`${p}: notified matches its roster facilities' caseload`,
    got >= want && got <= want + unmapped,
    `pipeline ${got}, roster-derived ${want}, facilities outside the roster ${unmapped}`);
}
check("almost every record resolves through a roster facility",
  unmapped <= Math.ceil(R.cnr.notified * 0.01), `${unmapped} of ${R.cnr.notified} unmapped`);

// The decisive one: residence must NOT drive attribution. Records whose facility is in one area
// but whose stated municipality is in another have to follow the facility.
{
  const g = GRID.cnr;
  const iFac = findCol(g[0], ["FACILITY"], ["TREATMENT"]);
  const iReg = findCol(g[0], ["REGISTRATION"]);
  const iProv = findCol(g[0], ["PROVINCE"]);
  let crossBoundary = 0;
  for (let i = 1; i < g.length; i++) {
    const r = g[i];
    if (!r) continue;
    if (!NR.has(norm(r[iReg]))) continue;
    const facArea = rosterProv[norm(r[iFac])];
    const stated = norm(r[iProv]);
    if (facArea && stated && stated !== facArea) crossBoundary++;
  }
  check("records whose facility and stated province differ do exist in this dataset",
    crossBoundary > 0, `${crossBoundary} - if zero, this test proves nothing`);
  // Those records follow the facility, which is exactly why the per-area totals above reconcile
  // against a roster-only recomputation that never looks at the patient's own province.
  check("per-area totals reconcile without consulting the patient's address at all",
    OPS.every((p) => {
      const got = N["P|" + p].cnr.notified, want = byFacility[p] || 0;
      return got >= want && got <= want + unmapped;
    }));
}

// ================================================================ 3. roster health is reported
// Attribution is only as good as the roster, and a roster mistake is invisible in the numbers -
// a province with no heading simply reads zero. These must be raised, not silently absorbed.
const issues = (kpi.meta.data_quality_issues || []).join(" ");
const areasMissing = OPS.filter((a) => !rosterAreas[a]);
check("an area absent from the roster is reported as a data-quality issue",
  areasMissing.length === 0 || areasMissing.every((a) => issues.indexOf(a) !== -1),
  `missing from roster: ${areasMissing.join(", ") || "(none)"}`);
for (const a of areasMissing) {
  check(`${a} is absent from the roster, so its zero count is explained rather than silent`,
    N["P|" + a].cnr.notified === 0 && issues.indexOf(a) !== -1,
    `notified ${N["P|" + a].cnr.notified}`);
}
check("facilities filed under a heading that contradicts their municipality are reported",
  /disagrees with their own Municipality/.test(issues) ||
    !hasHeadingConflict(), "no warning raised despite conflicting headings");

function hasHeadingConflict() {
  // muni -> province from POPULATION, then look for roster rows whose municipality says otherwise.
  const bl = (v) => v === null || v === undefined || String(v).trim() === "";
  const pop = GRID.pop;
  const muniOf = {};
  let prov = null;
  for (const r of pop) {
    if (!r) continue;
    if (!bl(r[0]) && bl(r[1])) { prov = norm(r[0]); continue; }
    if (bl(r[0]) && !bl(r[1]) && bl(r[2]) && prov) {
      const m = norm(r[1]);
      if (!m || m === "MUNICIPALITY") continue;
      if (muniOf[m] === undefined) muniOf[m] = prov; else if (muniOf[m] !== prov) muniOf[m] = null;
    }
  }
  const g = GRID.roster;
  let block = null;
  for (let i = 1; i < g.length; i++) {
    const r = g[i];
    if (!r) continue;
    const p = norm(r[0]);
    if (p) block = p;
    const m = norm(r[1]);
    if (!m || !block) continue;
    // Mirror the pipeline's own exemption: a municipality that IS one of the seven operational
    // areas (Naga City) is legitimately allowed its own roster block heading even though
    // POPULATION nests it as a municipality of its parent - that split is deliberate, not a
    // heading typo, so it must not be flagged as a conflict here either.
    if (OPS.indexOf(m) !== -1) continue;
    if (muniOf[m] && muniOf[m] !== block) return true;
  }
  return false;
}

// ================================================================ 4. nothing vanishes
check("meta accounts for anything that could not be placed in an area",
  kpi.meta.out_of_region && typeof kpi.meta.out_of_region.total === "number",
  JSON.stringify(kpi.meta.out_of_region));
if (kpi.meta.out_of_region) {
  check("unplaceable records are itemised by what their province said",
    Object.values(kpi.meta.out_of_region.by_province || {}).reduce((a, b) => a + b, 0)
      === kpi.meta.out_of_region.total,
    JSON.stringify(kpi.meta.out_of_region.by_province));
  check("region + unplaceable = every New/Relapse record in the two sheets",
    R.cnr.notified + kpi.meta.out_of_region.total === totalNewRelapse(),
    `${R.cnr.notified} + ${kpi.meta.out_of_region.total} vs ${totalNewRelapse()}`);
}

function totalNewRelapse() {
  let n = 0;
  for (const grid of [GRID.cnr, GRID.mn]) {
    const iReg = findCol(grid[0], ["REGISTRATION"]);
    for (let i = 1; i < grid.length; i++) if (grid[i] && NR.has(norm(grid[i][iReg]))) n++;
  }
  return n;
}

const pass = results.filter((r) => r[1]).length;
const fail = results.filter((r) => !r[1]);
for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
console.log("\n" + "=".repeat(70));
console.log(`TOTAL: ${pass}/${results.length} passed`);
console.log(fail.length === 0 ? "\nFACILITY-BASED ATTRIBUTION IS CORRECT" : "\nATTRIBUTION ISSUES FOUND");
process.exitCode = fail.length === 0 ? 0 : 1;
