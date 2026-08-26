// Awardee Recognition: category config + server-side candidate ranking.
//
// Mirrors the AWARD_CATEGORIES / awardCandidates() logic in vendor/dashboard_js_full.txt exactly.
// The public dashboard computes standings client-side from the KPI data it has already loaded, but
// the admin panel's override picker runs from a page that never loads the full public dashboard, so
// api/awards.js recomputes the same standings server-side from the currently published KPI via this
// module. Keep this file and the vendor copy in sync if the categories or metrics ever change.
const LABEL = {
  ALBAY: "Albay", "CAMARINES NORTE": "Camarines Norte", "CAMARINES SUR": "Camarines Sur",
  CATANDUANES: "Catanduanes", MASBATE: "Masbate", SORSOGON: "Sorsogon", "NAGA CITY": "Naga City",
};

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const AWARD_CATEGORIES = [
  { key: "cnr", label: "Case Notification", provinceUnit: "municipality",
    metric: (n) => (n && n.cnr) ? n.cnr.rate_per_100k : null },
  { key: "dstb_tsr", label: "DSTB Treatment Success", provinceUnit: "facility",
    metric: (n) => (n && n.tsr) ? n.tsr.dstb.rate : null },
  { key: "drtb_tsr", label: "DRTB Treatment Success", provinceUnit: "facility",
    metric: (n) => (n && n.tsr) ? n.tsr.drtb.rate : null },
  { key: "tpt", label: "TB Preventive Treatment", provinceUnit: "facility",
    metric: (n) => (n && n.tpt) ? n.tpt.coverage_pct : null },
];

function findCategory(key) {
  return AWARD_CATEGORIES.find((c) => c.key === key) || null;
}

// Applies the Month/Quarter-value selection to a resolved node, swapping in the precomputed
// by_month[periodValue] / by_quarter[periodValue] slice - mirrors periodNode() in
// vendor/dashboard_js_full.txt. Returns the full node when no period filter is requested.
function periodNode(node, period, periodValue) {
  if (!node || !period || !periodValue || periodValue === "ALL") return node;
  if (period === "monthly") return (node.by_month && node.by_month[periodValue]) || node;
  return (node.by_quarter && node.by_quarter[periodValue]) || node;
}

// Every operational province/city, ranked by the category's metric, highest first - same ranking as
// vendor/dashboard_js_full.txt's awardRegionCandidates().
function regionCandidates(kpi, catDef, period, periodValue) {
  const nodes = (kpi && kpi.nodes) || {};
  const ops = (kpi && kpi.meta && kpi.meta.operational_provinces) || [];
  return ops
    .map((p) => {
      const v = catDef.metric(periodNode(nodes["P|" + p], period, periodValue));
      return v == null ? null : { key: p, name: LABEL[p] || titleCase(p), value: v };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);
}

// Municipalities (Case Notification) or facilities (DSTB/DRTB TSR, TPT) within one province, ranked
// by the category's metric - same ranking as vendor/dashboard_js_full.txt's
// awardProvinceCandidates().
function provinceCandidates(kpi, catDef, province, period, periodValue) {
  const nodes = (kpi && kpi.nodes) || {};
  const prefix = catDef.provinceUnit === "municipality" ? `M|${province}|` : `F|${province}|`;
  const out = [];
  for (const key of Object.keys(nodes)) {
    if (!key.startsWith(prefix)) continue;
    const v = catDef.metric(periodNode(nodes[key], period, periodValue));
    if (v == null) continue;
    const parts = key.split("|");
    const rawName = catDef.provinceUnit === "municipality" ? parts[2] : parts[3];
    out.push({ key, name: titleCase(rawName), value: v });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** Ranked candidates for a category/scope, highest metric first. */
function candidatesFor(kpi, categoryKey, scope, province, period, periodValue) {
  const catDef = findCategory(categoryKey);
  if (!catDef) return [];
  return scope === "region"
    ? regionCandidates(kpi, catDef, period, periodValue)
    : provinceCandidates(kpi, catDef, province || "", period, periodValue);
}

module.exports = { AWARD_CATEGORIES, findCategory, candidatesFor, periodNode };
