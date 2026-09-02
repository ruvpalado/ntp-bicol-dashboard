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

// Treatment Success Rate is the primary sort key for the facility TSR categories. Facilities with an
// identical rate are then ranked by their Cure Rate (Cured / bact-confirmed or cohort x100), and if
// still tied, by the number of Bacteriologically Confirmed cases (higher first). These extra keys are
// read from the same per-facility node the primary metric comes from, so they survive the
// Month/Quarter period slice exactly like the rate does.
function tsrTiebreak(node, type) {
  const c = (node && node.tsr && node.tsr["cure_" + type]) || null;
  const cureValue = (c && typeof c.rate === "number") ? c.rate : null;
  // Bacteriologically Confirmed count: sum the TSR block's Bacteriologic Status buckets that match
  // "BACTERIOLOG*" and not "CLINIC*" - the same rule the pipeline's isBactConfirmed() uses. Works
  // regardless of whether cure_* fell back to the full-cohort denominator.
  const byStatus = (node && node.tsr && node.tsr[type] && node.tsr[type].by_bact_status) || {};
  let bactCount = 0;
  for (const [status, num] of Object.entries(byStatus)) {
    const s = String(status).toUpperCase();
    if (s.indexOf("BACTERIOLOG") !== -1 && s.indexOf("CLINIC") === -1) bactCount += num;
  }
  return { cureValue, bactCount };
}

const AWARD_CATEGORIES = [
  { key: "cnr", label: "Case Notification", provinceUnit: "municipality",
    metric: (n) => (n && n.cnr) ? n.cnr.rate_per_100k : null },
  { key: "dstb_tsr", label: "DSTB Treatment Success", provinceUnit: "facility",
    metric: (n) => (n && n.tsr) ? n.tsr.dstb.rate : null,
    tiebreak: (n) => tsrTiebreak(n, "dstb") },
  { key: "drtb_tsr", label: "DRTB Treatment Success", provinceUnit: "facility",
    metric: (n) => (n && n.tsr) ? n.tsr.drtb.rate : null,
    tiebreak: (n) => tsrTiebreak(n, "drtb") },
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

// Sorts candidates by the category's metric (highest first); for the facility TSR categories that
// carry the tsrTiebreak data, identical rates are then broken by Cure Rate and, if still tied, by the
// number of Bacteriologically Confirmed cases (higher first). Mirrors the front-end comparator.
function rankCandidates(items, catDef) {
  return items.sort((a, b) => {
    if (b.value - a.value !== 0) return b.value - a.value;
    if (catDef.tiebreak) {
      const aHasCure = a.cureValue == null ? 0 : 1;
      const bHasCure = b.cureValue == null ? 0 : 1;
      if (bHasCure - aHasCure !== 0) return bHasCure - aHasCure;
      if (b.cureValue - a.cureValue !== 0) return b.cureValue - a.cureValue;
      if (b.bactCount - a.bactCount !== 0) return b.bactCount - a.bactCount;
    }
    return 0;
  });
}

// Rank the category's own unit (facilities for DSTB/DRTB TSR + TPT, municipalities for Case
// Notification) by the metric, highest first. When a province is given this is that province's own
// ranking (key prefix "F|<province>|" / "M|<province>|"); when no province is given it is the whole
// region's ranking across every province (prefix "F|" / "M|"), with same-named units in different
// provinces disambiguated by their province name.
function unitCandidates(kpi, catDef, province, period, periodValue) {
  const nodes = (kpi && kpi.nodes) || {};
  const pk = catDef.provinceUnit === "municipality" ? "M" : "F";
  const nameIdx = catDef.provinceUnit === "municipality" ? 2 : 3;
  const prefix = province ? `${pk}|${province}|` : `${pk}|`;
  const out = [];
  for (const key of Object.keys(nodes)) {
    if (!key.startsWith(prefix)) continue;
    const resolved = periodNode(nodes[key], period, periodValue);
    const v = catDef.metric(resolved);
    if (v == null) continue;
    const parts = key.split("|");
    const rawName = parts[nameIdx] || "";
    const provKey = parts[1];
    const name = province
      ? titleCase(rawName)
      : titleCase(rawName) + " (" + (LABEL[provKey] || titleCase(provKey)) + ")";
    const item = { key, name, value: v };
    if (catDef.tiebreak) {
      const tb = catDef.tiebreak(resolved);
      item.cureValue = tb.cureValue;
      item.bactCount = tb.bactCount;
    }
    out.push(item);
  }
  return rankCandidates(out, catDef);
}

/** Ranked candidates for a category/scope, highest metric first. */
function candidatesFor(kpi, categoryKey, scope, province, period, periodValue) {
  const catDef = findCategory(categoryKey);
  if (!catDef) return [];
  // Both "region" and "province" ranking levels rank the category's own unit (facilities / the unit
  // the metric is defined over). "region" = every unit across the region; "province" = only those in
  // the selected province.
  const whichProvince = scope === "region" ? null : (province || "");
  return unitCandidates(kpi, catDef, whichProvince, period, periodValue);
}

module.exports = { AWARD_CATEGORIES, candidatesFor, periodNode };
