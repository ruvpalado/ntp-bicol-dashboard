// MN TSR must use Type=MN in TSR COHORT, not DS/DR or the MN notification count.
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
const facility = "BACACAY RURAL HEALTH UNIT";
const secondFacility = "DARAGA RURAL HEALTH UNIT";
const sheets = {
  POPULATION: [["Province", "Municipality", "Barangay", "Population"],
    ["Region V (Bicol Region)", null, null, 100000], ["Albay", null, null, 100000],
    [null, "Bacacay", null, 50000], [null, "Daraga", null, 50000]],
  "MN 2026": [["Province", "City/Municipality", "Screening/Diagnosing Health Facility", "Date of Diagnosis", "Outcome/Status"],
    // Deliberately different from the cohort: these notifications are NOT the TSR denominator.
    ["Albay", "Bacacay", facility, "2026-01-15", "CURED"],
    ["Albay", "Daraga", secondFacility, "2026-10-15", "DIED"]],
  "TSR  COHORT": [["Province", "City/Municipality", "Treatment Health Facility", "Date of Notification", "Type", "Outcome/Status"],
    ["Albay", "Bacacay", facility, "2026-01-15", "MN", "CURED"],
    ["Albay", "Bacacay", facility, "2026-01-16", "MN", "TREATMENT COMPLETED"],
    ["Albay", "Bacacay", facility, "2026-01-17", "MN", "DIED"],
    ["Albay", "Bacacay", facility, "2026-01-18", "MN", null],
    ["Albay", "Daraga", secondFacility, "2026-10-15", "MN", "DIED"],
    ["Albay", "Bacacay", facility, "2026-01-15", "DS", "CURED"],
    ["Albay", "Bacacay", facility, "2026-01-15", "DR", "TREATMENT COMPLETED"]],
};
const workbook = { SheetNames: Object.keys(sheets), Sheets: {} };
for (const [name, grid] of Object.entries(sheets)) workbook.Sheets[name] = XLSX.utils.aoa_to_sheet(grid);
const kpi = runPipelineOnWorkbook(workbook);
for (const key of ["REGION", "P|ALBAY"]) {
  check(`${key}: only MN successes / all MN cohort patients, including blank outcomes`, () => {
    assert.equal(kpi.nodes[key].tsr.mn.success, 2);
    assert.equal(kpi.nodes[key].tsr.mn.total, 5);
    assert.equal(kpi.nodes[key].tsr.mn.rate, 40);
    assert.equal(kpi.nodes[key].mn.total, 2);
  });
}
check("facility scope uses only its own MN cohort", () => assert.equal(kpi.nodes[`F|ALBAY|BACACAY|${facility}`].tsr.mn.rate, 50));
check("quarter with unsuccessful MN patients is zero, not n/a", () => assert.equal(kpi.nodes.REGION.by_quarter.Q4.tsr.mn.rate, 0));
check("quarter without MN patients is n/a, not zero", () => assert.equal(kpi.nodes.REGION.by_quarter.Q2.tsr.mn.rate, null));

// Retain period trees only for nodes selected below, keeping the browser fixture small.
const selectedKeys = new Set(["REGION", "P|ALBAY", `F|ALBAY|BACACAY|${facility}`]);
const browserKpi = { ...kpi, nodes: Object.fromEntries(Object.entries(kpi.nodes).map(([key, node]) => {
  if (selectedKeys.has(key)) return [key, node];
  const { by_month, by_quarter, ...fullNode } = node;
  return [key, fullNode];
})) };
const dom = new JSDOM(buildDashboardHtml(browserKpi), { runScripts: "outside-only", url: "https://example.test/" });
const { window } = dom;
window.Chart = class { destroy() {} };
const inline = [...window.document.scripts].find(script => script.textContent.includes("let KPI ="));
window.eval(inline.textContent);
window.document.querySelector('[data-m="mn"]').click();
function select(id, value) {
  const el = window.document.getElementById(id);
  assert.ok([...el.options].some(option => option.value === value), `${id} offers ${value}`);
  el.value = value;
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function card() {
  return [...window.document.querySelectorAll("#kpiRow .kpi-card")]
    .find(el => el.querySelector(".kpi-label").textContent === "TSR — MN");
}
function expectCard(rate, detail) {
  assert.ok(card(), "MN module includes its TSR KPI");
  assert.equal(card().querySelector(".kpi-value").textContent, rate);
  assert.equal(card().querySelector(".kpi-sub").textContent, detail);
}
check("MN module retains its five KPIs and adds MN TSR with numerator/denominator", () => {
  assert.equal(window.document.querySelectorAll("#kpiRow .kpi-card").length, 6);
  expectCard("40%", "2 cured + treatment completed / 5 MN patients");
});
select("fPeriod", "quarterly");
select("fPeriodValue", "Q1");
check("MN TSR follows quarter selection", () => expectCard("50%", "2 cured + treatment completed / 4 MN patients"));
select("fPeriodValue", "Q4");
check("MN TSR displays genuine zero success", () => expectCard("0%", "0 cured + treatment completed / 1 MN patients"));
select("fPeriodValue", "Q2");
check("MN TSR explains a missing cohort", () => expectCard("n/a", "no cohort rows submitted for this area"));
select("fPeriod", "monthly");
select("fPeriodValue", "January");
check("MN TSR follows month selection", () => expectCard("50%", "2 cured + treatment completed / 4 MN patients"));
select("fPeriodValue", "ALL");
select("fProvince", "ALBAY");
check("MN TSR follows province selection", () => expectCard("40%", "2 cured + treatment completed / 5 MN patients"));
select("fFacility", facility);
check("MN TSR follows facility selection", () => expectCard("50%", "2 cured + treatment completed / 4 MN patients"));
window.document.querySelector('[data-m="tsr"]').click();
check("existing TSR module remains unchanged", () => {
  assert.equal(window.document.querySelectorAll("#kpiRow .kpi-card").length, 4);
  // Switching from MN to the public-facility TSR roster resets the facility filter.
  expectCard("40%", "5 cohort");
});
dom.window.close();

for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : "\n  " + detail}`);
console.log(`\nTOTAL: ${results.filter(r => r[1]).length}/${results.length} passed`);
process.exitCode = results.every(r => r[1]) ? 0 : 1;
