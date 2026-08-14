// Server-side wrapper around vendor/ntp_pipeline_browser.js (the same
// vanilla-JS KPI pipeline used for the dashboard's in-browser "Upload New
// Excel" feature). That file has no DOM dependency at all - it only expects
// a global `XLSX` (SheetJS) and exposes `global.NTP_PIPELINE.runPipeline`.
// Reusing it here (rather than re-porting process_ntp_v4.py again) guarantees
// the admin-upload path computes byte-identical KPIs to the existing pipeline
// - verified against the reference dataset before this app was built.
const XLSX = require("xlsx");

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  global.XLSX = XLSX;
  const { pipelineBrowserJs } = require("./assets.generated");
  // eslint-disable-next-line no-eval
  (0, eval)(pipelineBrowserJs);
  if (!global.NTP_PIPELINE || typeof global.NTP_PIPELINE.runPipeline !== "function") {
    throw new Error("ntp_pipeline_browser.js did not expose NTP_PIPELINE.runPipeline as expected");
  }
  loaded = true;
}

/**
 * Runs the full KPI pipeline against an uploaded Excel file.
 * @param {Buffer} buffer - raw bytes of the uploaded .xlsx file
 * @param {(msg: string) => void} [onProgress]
 * @returns {object} the computed KPI dataset
 */
function runPipelineOnBuffer(buffer, onProgress) {
  ensureLoaded();
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return global.NTP_PIPELINE.runPipeline(workbook, onProgress || (() => {}));
}

/**
 * Runs the pipeline against an in-memory SheetJS workbook. Used by the province consolidation
 * path, which builds a combined workbook from stored rows rather than reading an uploaded file -
 * skipping a pointless write-to-xlsx-then-read-back round trip.
 * @param {object} workbook - a SheetJS workbook object ({ SheetNames, Sheets })
 * @param {(msg: string) => void} [onProgress]
 * @returns {object} the computed KPI dataset
 */
function runPipelineOnWorkbook(workbook, onProgress) {
  ensureLoaded();
  return global.NTP_PIPELINE.runPipeline(workbook, onProgress || (() => {}));
}

/**
 * Coerces a raw cell value to a Date using the pipeline's own parser, or null if unparseable.
 * Used by upload-time validation (lib/provinceTemplate.js) so a file is rejected using the exact
 * same rule that would otherwise silently exclude the row from date-based figures downstream.
 * @param {*} v - raw cell value (Date, Excel serial number, or string)
 * @returns {Date|null}
 */
function coerceDateValue(v) {
  ensureLoaded();
  return global.NTP_PIPELINE.coerceDate(v);
}

module.exports = { runPipelineOnBuffer, runPipelineOnWorkbook, coerceDateValue };
