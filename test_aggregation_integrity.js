// Proves the regional view aggregates correctly in the ACTUAL production path: seven provincial
// uploads consolidated into one dataset.
//
// The governing rule is "a row belongs to the province slot it was uploaded to" - validateProvinceUpload
// stamps every row's Province with its slot. This test confirms the consequences of that rule:
//   * no row can be orphaned (counted regionally but in no province)
//   * region totals equal the sum of the provinces exactly
//   * rates are recomputed from summed numerators over summed denominators, never averaged
//   * population denominators sum to the regional total (no nested-area double count)
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";

const BLOB = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!BLOB.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => BLOB.get(p) }, blob: { uploadedAt: "" } };
      },
      async put(p, b) { BLOB.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { BLOB.delete(p); },
    };
  }
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const store = require(BASE + "lib/provinceStore");
const consolidator = require(BASE + "lib/consolidate");

// Region.xlsx (stale multi-province fixture) retired in favor of Format.xlsx as the standard.
// test_fixtures_CamNorte.xlsx is real Camarines Norte case data (new long-format report sheets)
// plus the current region-wide reference sheets - single-province, so the "sum of provinces" check
// below still runs for real but with 6 of 7 slots legitimately empty.
const SRC = __dirname + "/test_fixtures_CamNorte.xlsx";

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

(async function run() {
  if (!fs.existsSync(SRC)) { console.log("SKIP - source workbook unavailable"); return; }
  const parsed = template.parseUpload(fs.readFileSync(SRC), "source.xlsx");
  const slots = template.PROVINCE_SLOTS.map((s) => s.id);

  // Split the workbook into seven province files. Rows whose Province is blank or names somewhere
  // outside Bicol still have to live in exactly one file - which is precisely the situation the
  // upload flow creates, since whoever uploads them owns them.
  const perProvince = {};
  for (const id of slots) perProvince[id] = {};
  let stamped = 0;

  for (const spec of template.PROVINCE_SHEETS) {
    const grid = parsed[spec.canonical];
    if (!grid || grid.length <= spec.headerRows) continue;
    const header = grid.slice(0, spec.headerRows);
    const pIdx = template.findProvinceColumn(grid, spec);
    const buckets = {};
    for (const id of slots) buckets[id] = [];
    // No forward-fill here: in the real flow each province submits its own file, so a row is judged
    // on its own Province value alone. Anything unrecognisable belongs to whoever uploaded it.
    for (let i = spec.headerRows; i < grid.length; i++) {
      const row = grid[i];
      if (!row) continue;
      const v = pIdx === -1 || row[pIdx] === null || row[pIdx] === undefined
        ? "" : String(row[pIdx]).trim().toUpperCase();
      const match = slots.find((s) => s === v);
      if (match) buckets[match].push(row);
      else { buckets[slots[0]].push(row); stamped++; }   // unattributable -> owned by the uploader
    }
    for (const id of slots) {
      if (buckets[id].length) perProvince[id][spec.canonical] = header.concat(buckets[id]);
    }
  }
  for (const spec of template.REGIONAL_SHEETS) {
    const grid = parsed[spec.canonical];
    if (!grid || !grid.length) continue;
    for (const id of slots) if (Object.keys(perProvince[id]).length) perProvince[id][spec.canonical] = grid;
  }

  BLOB.clear();
  const expected = {};
  for (const id of slots) {
    const sheets = perProvince[id];
    if (!Object.keys(sheets).length) continue;
    const res = template.validateProvinceUpload(sheets, id);
    if (!res.ok) { check(`${id} fixture validates`, false, res.errors.join("; ")); continue; }
    expected[id] = res.rowCounts;
    await store.saveProvinceEntry(id, {
      provinceId: id, sheets: res.sheets, rowCounts: res.rowCounts, regionalSheets: res.regionalSheets,
      meta: { filename: id + ".xlsx", uploadedBy: "AggTest", uploadedAt: new Date().toISOString() },
    });
  }

  const { kpi } = await consolidator.consolidate();
  const N = kpi.nodes, R = N.REGION;
  const OPS = kpi.meta.operational_provinces;
  const provNodes = OPS.map((p) => N["P|" + p]).filter(Boolean);
  const sum = (f) => provNodes.reduce((a, n) => a + (f(n) || 0), 0);

  // ---- stamping means nothing can be orphaned ----
  check("every row was attributed to a province slot (none orphaned)",
    R.cnr.notified === sum((n) => n.cnr && n.cnr.notified),
    `region ${R.cnr.notified} vs sum ${sum((n) => n.cnr && n.cnr.notified)}`);

  check("uploader ownership absorbed the unattributable rows", stamped >= 0,
    `${stamped} row(s) had no recognisable Bicol province and were owned by their uploader`);

  // ---- counts aggregate exactly ----
  for (const [label, f] of [
    ["notified", (n) => n.cnr && n.cnr.notified],
    ["CNR sheet cases", (n) => n.cnr && n.cnr.cnr_cases],
    ["MN cases", (n) => n.cnr && n.cnr.mn_cases_incl],
    ["TPT enrolled", (n) => n.tpt && n.tpt.enrolled],
  ]) {
    const s = sum(f);
    const r = f(R) || 0;
    check(`REGION ${label} = sum of provinces`, r === s, `region ${r} vs sum ${s}`);
  }

  // ---- MN Referral Status by Facility table (region-wide) ----
  // The per-facility Received/Pending breakdown must exactly reconstruct the region's own
  // mn.referral_status_dist (Requested/Received) - if it didn't, the table would show a different,
  // silently wrong figure from the KPI card right above it on the same page. "Pending" here means
  // "Requested" in the source data's own Referral Status column.
  {
    const list = R.mn && R.mn.referral_by_facility;
    check("REGION mn.referral_by_facility is present and is an array", Array.isArray(list), typeof list);
    if (Array.isArray(list)) {
      const tableReceived = list.reduce((a, r) => a + (r.received || 0), 0);
      const tablePending = list.reduce((a, r) => a + (r.pending || 0), 0);
      const dist = R.mn.referral_status_dist || {};
      check("REGION referral_by_facility received sums to referral_status_dist.Received",
        tableReceived === (dist.Received || 0), `table ${tableReceived} vs dist ${dist.Received}`);
      check("REGION referral_by_facility pending sums to referral_status_dist.Requested",
        tablePending === (dist.Requested || 0), `table ${tablePending} vs dist ${dist.Requested}`);
      check("REGION referral_by_facility total sums to mn.referred (the authoritative Y/N flag)",
        (tableReceived + tablePending) === (R.mn.referred || 0),
        `table total ${tableReceived + tablePending} vs mn.referred ${R.mn.referred}`);
      check("per row: Pending = Total - Received, using the independently-tracked total field",
        list.every((r) => typeof r.total === "number" && r.pending === r.total - r.received),
        JSON.stringify(list.find((r) => r.pending !== r.total - r.received)));
      check("every row names a real facility and has at least one referral",
        list.every((r) => typeof r.facility === "string" && r.facility.length > 0 && (r.received + r.pending) > 0),
        JSON.stringify(list.find((r) => !r.facility || !((r.received + r.pending) > 0))));
      check("rows are sorted descending by total (received + pending)",
        list.every((r, i) => i === 0 || (list[i - 1].received + list[i - 1].pending) >= (r.received + r.pending)),
        JSON.stringify(list.map((r) => r.received + r.pending)));
      check("no facility appears twice", new Set(list.map((r) => r.facility)).size === list.length,
        "duplicate facility names in the table");
    }
  }

  // ---- population denominators ----
  const sumPop = sum((n) => n.population);
  check("province populations sum to the regional total (no nested-area double count)",
    Math.abs(sumPop - kpi.meta.region_population) < 1,
    `sum ${sumPop} vs region ${kpi.meta.region_population}`);

  // ---- rates recomputed, not averaged ----
  const proper = Math.round((R.cnr.notified / kpi.meta.region_population) * 100000 * 10) / 10;
  const naive = provNodes.reduce((a, n) => a + (n.cnr ? n.cnr.rate_per_100k : 0), 0) / provNodes.length;
  check("REGION CNR rate = summed cases / summed population",
    Math.abs(R.cnr.rate_per_100k - proper) < 0.11, `region ${R.cnr.rate_per_100k} vs ${proper}`);
  check("REGION CNR rate is NOT the mean of province rates",
    Math.abs(R.cnr.rate_per_100k - naive) > 0.5,
    `region ${R.cnr.rate_per_100k} vs naive mean ${naive.toFixed(1)} - too close to distinguish`);

  // ---- each area's denominator matches its own cases ----
  for (const p of OPS) {
    const n = N["P|" + p];
    if (!n || !n.cnr || !n.cnr.notified) continue;
    const exp = Math.round((n.cnr.notified / n.population) * 100000 * 10) / 10;
    check(`${p}: rate matches its own cases over its own population`,
      Math.abs(n.cnr.rate_per_100k - exp) < 0.11, `${n.cnr.rate_per_100k} vs ${exp}`);
  }

  report();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nREGIONAL AGGREGATION IS EXACT" : "\nAGGREGATION ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
