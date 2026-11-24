// Regression: valid July–December dates must survive month/quarter filtering and charting.
// Exercise the shipped pipeline, then change the real dropdowns in the rendered dashboard.
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { JSDOM } = require("jsdom");
const { runPipelineOnWorkbook } = require("./lib/pipeline");
const { buildDashboardHtml } = require("./lib/buildDashboardHtml");

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, true]); }
  catch (err) { results.push([name, false, err.message]); }
}
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const sheets = { POPULATION: [
  ["Province", "Municipality", "Barangay", "Population"],
  ["Region V (Bicol Region)", null, null, 75567],
  ["Albay", null, null, 75567],
  [null, "Bacacay", null, 75567],
] };
const facility = "BACACAY RURAL HEALTH UNIT";
for (const name of ["CNR 2026 ", "MN 2026", "TPT 2026", "TSR  COHORT", "TPT COHORT"]) {
  const diagnosis = name === "MN 2026";
  const cohort = name.includes("COHORT");
  const header = ["Province", "City/Municipality", cohort ? "Treatment Health Facility" : "Screening/Diagnosing Health Facility",
    diagnosis ? "Date of Diagnosis" : "Date of Notification", "Registration Group", "Type", "Outcome/Status", "Indication for TPT"];
  // Cover the existing date parser's supported representations, including quarter boundaries.
  const dates = months.map((_, i) => i % 3 === 0 ? new Date(2026, i, 15) : i % 3 === 1
    ? Math.round((Date.UTC(2026, i, 15) - Date.UTC(1899, 11, 30)) / 86400000)
    : `2026-${String(i + 1).padStart(2, "0")}-15`);
  dates.push("not a date");
  sheets[name] = [header, ...dates.map(date => ["Albay", "Bacacay", facility, date, "New", cohort ? "DS" : "DSTB", "TREATMENT COMPLETED", "Household contact"])];
}
const workbook = { SheetNames: Object.keys(sheets), Sheets: {} };
for (const [name, grid] of Object.entries(sheets)) workbook.Sheets[name] = XLSX.utils.aoa_to_sheet(grid);
const kpi = runPipelineOnWorkbook(workbook);
const metrics = {
  CNR: n => n.cnr.cnr_cases,
  MN: n => n.mn.total,
  TPT: n => n.tpt.enrolled,
  TSR: n => n.tsr.all.total,
  "TPT Cohort": n => n.tpt.cohort_total,
};
for (const key of ["REGION", "P|ALBAY", `F|ALBAY|BACACAY|${facility}`]) {
  const node = kpi.nodes[key];
  check(`${key} exists`, () => assert.ok(node));
  if (!node) continue;
  for (const [metric, count] of Object.entries(metrics)) {
    check(`${key} ${metric}: unfiltered retains undated row`, () => assert.equal(count(node), 13));
    for (const month of months) {
      check(`${key} ${metric}: ${month} only`, () => assert.equal(count(node.by_month[month]), 1));
    }
    for (const q of ["Q1", "Q2", "Q3", "Q4"]) {
      check(`${key} ${metric}: ${q} has its three dated rows`, () => assert.equal(count(node.by_quarter[q]), 3));
    }
  }
}
check("trend metadata spans twelve months", () => assert.deepEqual(kpi.meta.months, months));
check("TPT monthly average uses the same twelve-month calendar", () => assert.equal(kpi.nodes.REGION.tpt.monthly_avg, 1.1));
for (const [metric, trend] of Object.entries({ CNR: kpi.nodes.REGION.cnr.trend_dstb, MN: kpi.nodes.REGION.mn.trend, TPT: kpi.nodes.REGION.tpt.trend })) {
  check(`${metric} trend covers every calendar month`, () => assert.deepEqual(trend, months.map(() => 1)));
}

// Only the selected REGION needs precomputed period slices for the browser interactions below.
// Keep other nodes' full totals for the regional comparisons without embedding hundreds of
// unused facility period trees in jsdom (the pipeline's built-in roster adds those facilities).
const browserKpi = { ...kpi, nodes: Object.fromEntries(Object.entries(kpi.nodes).map(([key, node]) => {
  if (key === "REGION") return [key, node];
  const { by_month, by_quarter, ...fullNode } = node;
  return [key, fullNode];
})) };
const dom = new JSDOM(buildDashboardHtml(browserKpi), { runScripts: "outside-only", url: "https://example.test/" });
const { window } = dom;
const chartConfigs = new Map();
window.Chart = class {
  constructor(el, config) { chartConfigs.set(el.id, config); }
  destroy() {}
};
// External CDN scripts are not loaded; execute the actual inline application bundle only.
const inline = [...window.document.scripts].find(script => script.textContent.includes("let KPI ="));
window.eval(inline.textContent);
function select(id, value) {
  const el = window.document.getElementById(id);
  assert.ok(el, `${id} exists`);
  el.value = value;
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}
check("monthly CNR chart reaches December", () => assert.deepEqual(Array.from(chartConfigs.get("c_cnrTrend").data.labels), months));
select("fPeriod", "quarterly");
check("quarterly CNR chart includes Q3 and Q4", () => {
  const chart = chartConfigs.get("c_cnrTrend");
  assert.deepEqual(Array.from(chart.data.labels), ["Q1 (Jan-Mar)", "Q2 (Apr-Jun)", "Q3 (Jul-Sep)", "Q4 (Oct-Dec)"]);
  assert.deepEqual(Array.from(chart.data.datasets[0].data), [6, 6, 6, 6]);
});
check("legacy six-month trends leave Q3/Q4 unknown rather than inventing zeros", () => {
  const data = require("node:vm").runInNewContext(`(${window.periodData.toString()})([1, 1, 1, 1, 1, 1]).data`, {
    KPI: { meta: { months: months.slice(0, 6), quarters: kpi.meta.quarters } },
    state: { period: "quarterly" },
  });
  assert.deepEqual(Array.from(data), [3, 3, null, null]);
});
for (const q of ["Q3", "Q4"]) {
  select("fPeriodValue", q);
  check(`selecting ${q} renders six notified CNR+MN cases`, () => {
    assert.equal(window.eval("currentNode().node.cnr.notified"), 6);
    assert.match(window.document.getElementById("moduleContent").textContent, /6 notified/);
    const data = Array.from(chartConfigs.get("c_cnrTrend").data.datasets[0].data);
    assert.deepEqual(data, q === "Q3" ? [0, 0, 6, 0] : [0, 0, 0, 6]);
  });
}
select("fPeriod", "monthly");
select("fPeriodValue", "September");
check("selecting September retains only its own cases", () => assert.equal(window.eval("currentNode().node.cnr.notified"), 2));
select("fPeriodValue", "ALL");
check("All Months restores all records without guessing undated rows into a month", () => assert.equal(window.eval("currentNode().node.cnr.notified"), 26));
dom.window.close();

for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : "\n  " + detail}`);
console.log(`\nTOTAL: ${results.filter(r => r[1]).length}/${results.length} passed`);
process.exitCode = results.every(r => r[1]) ? 0 : 1;
