// Assembles the full dashboard document exactly like the original build
// recipe (template + browser pipeline + rendering JS, with the KPI JSON
// substituted in) - just done at request time from the current stored KPI
// data instead of once at file-build time.
// awardsJson (Awardee Recognition records) is substituted in the same way, via its own
// __AWARDS_JSON__ placeholder - independent of the KPI data, since awardees are Admin-assigned
// records rather than something derived from Region.xlsx. Defaults to an empty period map if not
// provided, so existing callers that only pass kpiJson don't break.
// activationJson (per-area Awardee Recognition activation dates, { "<AREA>": "YYYY-MM-DD" }) is a
// third, independent substitution for the same reason - it is Admin-set and has nothing to do with
// Region.xlsx or the yearly awards records. Defaults to an empty object (every area not-yet-active)
// if not provided.
const { templatePart1, dashboardJsFull, pipelineBrowserJs } = require("./assets.generated");

function buildDashboardHtml(kpiJson, awardsJson, activationJson) {
  return (
    templatePart1 +
    pipelineBrowserJs +
    dashboardJsFull
      .replace("__DATA_JSON__", JSON.stringify(kpiJson), 1)
      .replace("__AWARDS_JSON__", JSON.stringify(awardsJson || {}), 1)
      .replace("__ACTIVATION_JSON__", JSON.stringify(activationJson || {}), 1) +
    "\n</script>\n</body>\n</html>\n"
  );
}

module.exports = { buildDashboardHtml };
