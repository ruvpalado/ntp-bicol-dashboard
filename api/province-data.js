// GET    /api/province-data            -> status of every province slot + upload history
// GET    /api/province-data?template=1 -> downloads a blank .xlsx template with the expected sheets
// DELETE /api/province-data?province=X -> removes that province's file and re-consolidates
//
// All admin-only. The status payload drives the admin page's slot list, including the
// "No file uploaded" state the spec calls for.
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const { query } = require("../lib/httpUtil");
const { clearKpi } = require("../lib/kpiStore");
const {
  PROVINCE_SLOTS, REFERENCE_SLOTS, SHEET_SPECS, PROVINCE_SHEETS, ACCEPTED_EXTENSIONS, findProvince,
} = require("../lib/provinceTemplate");
const {
  getAllProvinceEntries, getAllReferenceEntries, deleteProvinceEntry, getHistory, appendHistory,
  clearHistory, blobConfigured,
} = require("../lib/provinceStore");
const { consolidateAndPublish } = require("../lib/consolidationClient");
const { canClearHistory } = require("../lib/historyAccess");

// The literal upload template admins download, shipped as a real workbook rather than generated on
// the fly - only the province-scoped sheets (CNR, MN, TPT, TSR/TPT Cohort, the lab report sheets,
// Treatment Follow-up, PICT). No POPULATION or Facility List sheets: those are region-wide and
// maintained once via the dedicated Regional Reference Data slots, not per-province, so a province
// template that included them would misleadingly suggest every province re-supplies its own copy.
const STATIC_TEMPLATE_PATH = path.join(__dirname, "..", "assets", "NTP_Province_Upload_Template.xlsx");

// Fallback only: a blank workbook built from SHEET_SPECS, used if the shipped template file is ever
// missing from the deployment. Not the normal path - see STATIC_TEMPLATE_PATH above.
function buildTemplateWorkbook(headerSource) {
  const wb = XLSX.utils.book_new();
  for (const spec of SHEET_SPECS) {
    const stored = headerSource ? headerSource[spec.canonical] : null;
    let aoa;
    if (stored && stored.grid && stored.grid.length) {
      aoa = stored.grid.slice(0, Math.max(1, spec.headerRows));
    } else if (spec.requiredColumns.length) {
      aoa = [spec.requiredColumns.slice()];
    } else {
      // No sample header on file yet - emit a labelled placeholder row rather than a blank sheet.
      aoa = [["(paste the " + spec.label + " sheet from Format.xlsx here, header rows included)"]];
    }
    // Canonical names carry deliberate odd whitespace ("CNR 2026 ", "TSR  COHORT"); write verbatim.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), spec.canonical);
  }
  return wb;
}

async function handler(req, res) {
  // Unlike GET / (api/index.js), this response was never marked non-cacheable - a GET here without
  // Cache-Control could be served stale by the browser or an intermediary on a later admin page
  // load, showing a slot as "No file uploaded" (or "Uploaded") when the real state has since
  // changed. Set unconditionally, before any early return, so every response path (status, template
  // download, delete) is covered.
  res.setHeader("Cache-Control", "no-store");
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  // ---------------------------------------------------------------- template download
  if (req.method === "GET" && query(req, "template")) {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="NTP_Province_Upload_Template.xlsx"');
    try {
      const buf = fs.readFileSync(STATIC_TEMPLATE_PATH);
      res.status(200).send(buf);
    } catch (e) {
      // Shouldn't happen (the file ships with the deployment), but fall back rather than 500 if it's
      // ever missing - prefer real stored headers over placeholders when possible.
      console.error("Static upload template missing, falling back to a generated one:", e);
      let headerSource = null;
      try {
        const all = await getAllProvinceEntries();
        headerSource = {};
        for (const id of Object.keys(all)) {
          const entry = all[id];
          if (!entry) continue;
          Object.assign(headerSource, entry.regionalSheets || {}, entry.sheets || {});
        }
      } catch (e2) { /* fall back to placeholders */ }
      const wb = buildTemplateWorkbook(headerSource);
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.status(200).send(buf);
    }
    return;
  }

  // ---------------------------------------------------------------- status
  if (req.method === "GET") {
    const emptyReference = REFERENCE_SLOTS.map((s) => ({
      id: s.id, label: s.label, hint: s.hint, sheets: s.sheets,
      uploaded: false, status: "No file uploaded",
    }));
    if (!blobConfigured()) {
      res.status(200).json({
        blobConfigured: false,
        slots: PROVINCE_SLOTS.map((s) => ({ ...s, uploaded: false, status: "No file uploaded" })),
        referenceSlots: emptyReference,
        history: [], acceptedFormats: ACCEPTED_EXTENSIONS,
        sheets: PROVINCE_SHEETS.map((s) => ({ name: s.canonical, label: s.label, required: s.required })),
      });
      return;
    }
    const entries = await getAllProvinceEntries();
    const referenceEntries = await getAllReferenceEntries();
    const history = await getHistory();
    res.status(200).json({
      blobConfigured: true,
      slots: PROVINCE_SLOTS.map((slot) => {
        const e = entries[slot.id];
        return {
          id: slot.id,
          label: slot.label,
          uploaded: !!e,
          status: e ? "Uploaded" : "No file uploaded",
          filename: e && e.meta ? e.meta.filename : null,
          uploadedBy: e && e.meta ? e.meta.uploadedBy : null,
          uploadedAt: e && e.meta ? e.meta.uploadedAt : null,
          rowCounts: e ? e.rowCounts : null,
          totalRows: e ? Object.values(e.rowCounts || {}).reduce((a, b) => a + b, 0) : 0,
          warnings: e && e.meta ? e.meta.warnings || [] : [],
        };
      }),
      referenceSlots: REFERENCE_SLOTS.map((slot) => {
        const e = referenceEntries[slot.id];
        return {
          id: slot.id,
          label: slot.label,
          hint: slot.hint,
          sheets: slot.sheets,
          uploaded: !!e,
          // "Uploaded" here also means "authoritative": consolidation prefers this file over the
          // copies inside the provincial workbooks.
          status: e ? "Uploaded" : "No file uploaded",
          filename: e && e.meta ? e.meta.filename : null,
          uploadedBy: e && e.meta ? e.meta.uploadedBy : null,
          uploadedAt: e && e.meta ? e.meta.uploadedAt : null,
          rowCounts: e ? e.rowCounts : null,
          totalRows: e ? Object.values(e.rowCounts || {}).reduce((a, b) => a + b, 0) : 0,
          warnings: e && e.meta ? e.meta.warnings || [] : [],
        };
      }),
      history,
      acceptedFormats: ACCEPTED_EXTENSIONS,
      sheets: PROVINCE_SHEETS.map((s) => ({ name: s.canonical, label: s.label, required: s.required })),
    });
    return;
  }

  // ---------------------------------------------------------------- clear the upload history log
  // Deliberately separate from the province-delete branch below (keyed by ?clearHistory=1 instead
  // of ?province=X) so it can never be reached by a malformed/missing province param - this removes
  // only the recorded history entries themselves, never a province/reference dataset or the
  // published dashboard. Restricted to one specific account (see lib/historyAccess.js) - the button
  // is hidden from everyone else on the admin page, and this check is the real enforcement in case
  // the request is ever made directly rather than through that button.
  if (req.method === "DELETE" && query(req, "clearHistory")) {
    if (!canClearHistory(getSessionIdentity(req))) {
      res.status(403).json({ error: "Not permitted to clear upload history." });
      return;
    }
    try {
      await clearHistory();
      res.status(200).json({ ok: true, message: "Upload history cleared." });
    } catch (err) {
      console.error("Clear history failed:", err);
      res.status(400).json({ error: (err && err.message) || "Unknown error" });
    }
    return;
  }

  // ---------------------------------------------------------------- delete a province file
  if (req.method === "DELETE") {
    const provinceId = query(req, "province");
    const uploadedBy = (query(req, "uploadedBy") || "").trim();
    const province = findProvince(provinceId);
    if (!province) { res.status(400).json({ error: `Unknown province slot "${provinceId}".` }); return; }
    if (!uploadedBy) { res.status(400).json({ error: "\"Uploaded by\" is required for the history log." }); return; }

    try {
      await deleteProvinceEntry(province.id);
      // Re-consolidate what remains. A deleted file must not linger on the dashboard just because
      // there was nothing left to recompute from - so if consolidation can't produce a dataset
      // (this was the only area uploaded, or it was the region's only POPULATION source), the
      // published KPI is unpublished entirely rather than left as it was. The public site then
      // falls back to its normal "awaiting uploads" page, the same one shown before anything was
      // ever uploaded, instead of continuing to show the file that was just deleted.
      let message = "Province file removed.";
      try {
        // Force this province out of consolidation regardless of whether Blob storage's read-back
        // has caught up with the delete() just issued - otherwise a lagging get() can hand back the
        // file that was just removed, and it gets consolidated right back in.
        const consolidation = await consolidateAndPublish({ province: { [province.id]: null } });
        message += ` Regional view rebuilt from ${consolidation.presentProvinces.length} remaining province dataset(s).`;
      } catch (consErr) {
        await clearKpi();
        message += " No regional view is currently published: " + consErr.message;
      }
      await appendHistory({ action: "delete", target: province.label, uploadedBy, ok: true, message });
      res.status(200).json({ ok: true, message });
    } catch (err) {
      console.error("Province delete failed:", err);
      res.status(400).json({ error: (err && err.message) || "Unknown error" });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

module.exports = handler;
