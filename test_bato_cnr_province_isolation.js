// Shared facility names must contribute to each municipality only in their own province.
// Synthetic cases reproduce the Bato Catanduanes empty-state bug; no patient data is used.
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { JSDOM } = require("jsdom");
const { runPipelineOnWorkbook } = require("./lib/pipeline");
const { buildDashboardHtml } = require("./lib/buildDashboardHtml");

function workbook(reverseMajority) {
  const sheets = {
    POPULATION: [
      ["Province", "Municipality", "Barangay", "Population"],
      ["Region V (Bicol Region)", null, null, 4000],
      ["Catanduanes", null, null, 1000], [null, "Bato", null, 1000],
      ["Camarines Sur", null, null, 2000], [null, "Bato", null, 1000], [null, "San Fernando", null, 1000],
      ["Masbate", null, null, 1000], [null, "San Fernando", null, 1000],
    ],
    "CNR 2026 ": [["Province", "City/Municipality", "Screening/Diagnosing Health Facility", "Date of Notification", "Registration Group", "Type"]],
  };
  const counts = {
    "CATANDUANES|BATO": reverseMajority ? 9 : 3,
    "CAMARINES SUR|BATO": reverseMajority ? 3 : 9,
    "CAMARINES SUR|SAN FERNANDO": reverseMajority ? 2 : 6,
    "MASBATE|SAN FERNANDO": reverseMajority ? 6 : 2,
  };
  for (const [key, count] of Object.entries(counts)) {
    const [province, municipality] = key.split("|");
    const facility = `${municipality} RURAL HEALTH UNIT - IDOTS`;
    for (let i = 0; i < count; i++) {
      // Patient residence is deliberately elsewhere: attribution follows the facility's town.
      sheets["CNR 2026 "].push([province, "OTHER TOWN", facility, i % 2 ? "2026-07-15" : "2026-01-15", i % 2 ? "Relapse" : "New", "DSTB"]);
    }
    sheets["CNR 2026 "].push([province, municipality, facility, "2026-01-15", "Other", "DSTB"]);
  }
  const wb = { SheetNames: Object.keys(sheets), Sheets: {}, __trustProvinceColumn: true };
  for (const [name, grid] of Object.entries(sheets)) wb.Sheets[name] = XLSX.utils.aoa_to_sheet(grid);
  return { wb, counts };
}

let checks = 0;
let browserKpi;
for (const reverseMajority of [false, true]) {
  const { wb, counts } = workbook(reverseMajority);
  const kpi = runPipelineOnWorkbook(wb);
  for (const [key, expected] of Object.entries(counts)) {
    const [province, municipality] = key.split("|");
    const facility = `${municipality} RURAL HEALTH UNIT - IDOTS`;
    const node = kpi.nodes[`M|${key}`];
    const facilityNode = kpi.nodes[`F|${key}|${facility}`];
    assert.ok(kpi.geo[province][municipality].includes(facility));
    for (const [scope, total] of [[null, expected], ["January", Math.ceil(expected / 2)], ["July", Math.floor(expected / 2)], ["Q1", Math.ceil(expected / 2)], ["Q3", Math.floor(expected / 2)], ["Q4", 0]]) {
      const view = scope ? (node.by_month[scope] || node.by_quarter[scope]) : node;
      const facView = scope ? (facilityNode.by_month[scope] || facilityNode.by_quarter[scope]) : facilityNode;
      assert.equal(view.cnr.cnr_cases, total, `${key} ${scope || "full"}: only this province's New/Relapse cases`);
      assert.equal(view.cnr.cnr_cases, facView.cnr.cnr_cases, `${key}: municipality matches its facility`);
      assert.equal(view.cnr.notified, total);
      assert.equal(view.cnr.top_facilities[facility] || 0, total);
      checks += 4;
    }
    assert.equal(node.cnr.rate_per_100k, Math.round(expected / 1000 * 100000 * 10) / 10);
    checks++;
  }
  assert.equal(kpi.nodes.REGION.cnr.cnr_cases, 20, "regional total is unchanged");
  for (const province of ["CATANDUANES", "CAMARINES SUR", "MASBATE"]) {
    const expected = Object.entries(counts).filter(([key]) => key.startsWith(province + "|")).reduce((sum, [, n]) => sum + n, 0);
    assert.equal(kpi.nodes[`P|${province}`].cnr.cnr_cases, expected, "provincial total is unchanged");
  }
  browserKpi = kpi;
}

// Exercise the actual CNR module's dropdowns with the newly computed dataset.
// Retain period trees only for the Bato nodes exercised below, not the whole built-in roster.
browserKpi = { ...browserKpi, nodes: Object.fromEntries(Object.entries(browserKpi.nodes).map(([key, node]) => {
  if (key.startsWith("M|CATANDUANES|BATO") || key.startsWith("F|CATANDUANES|BATO|")) return [key, node];
  const { by_month, by_quarter, ...fullNode } = node;
  return [key, fullNode];
})) };
const dom = new JSDOM(buildDashboardHtml(browserKpi), { runScripts: "outside-only", url: "https://example.test/" });
const { window } = dom;
window.Chart = class { destroy() {} };
window.eval([...window.document.scripts].find(script => script.textContent.includes("let KPI =")).textContent);
function select(id, value) {
  const el = window.document.getElementById(id);
  assert.ok(el, id);
  el.value = value;
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}
window.document.querySelector('[data-m="cnr"]').click();
select("fProvince", "CATANDUANES");
select("fMuni", "BATO");
assert.equal(window.eval("currentNode().node.cnr.cnr_cases"), 9);
assert.match(window.document.getElementById("moduleContent").textContent, /9 notified/);
select("fFacility", "BATO RURAL HEALTH UNIT - IDOTS");
assert.equal(window.eval("currentNode().node.cnr.cnr_cases"), 9);
select("fFacility", "ALL");
select("fPeriod", "monthly");
select("fPeriodValue", "July");
assert.equal(window.eval("currentNode().node.cnr.cnr_cases"), 4);
assert.match(window.document.getElementById("moduleContent").textContent, /4 notified/);
dom.window.close();
console.log(`PASS: ${checks} CNR aggregation checks plus province/region totals and rendered Bato dropdown interactions`);
