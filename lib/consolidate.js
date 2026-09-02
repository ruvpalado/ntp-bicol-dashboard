// ETL: merges every province's stored sheets with the region-wide reference sheets into a single
// workbook laid out exactly like Format.xlsx, then re-runs the existing KPI pipeline over it.
//
// Two rules do the real work here:
//
// 1. PROVINCE-SCOPED sheets are concatenated: one copy of the header block (taken from the first
//    province that supplied the sheet) followed by every province's data rows in turn. Because the
//    header block is preserved verbatim, the pipeline's fixed header offsets - objRows(...,0),
//    rawRows(...).slice(3) and so on - land exactly where they do in the original workbook.
//
// 2. REGION-WIDE sheets (POPULATION, POPULATION CATCHMENT, Facility List, TARGET 2026) are never
//    concatenated - every province's Format.xlsx carries the same region-wide block, so appending
//    them would repeat the region's population once per uploading province and inflate every
//    denominator. Exactly one copy is used, chosen in this order:
//      a. the dedicated regional upload for that sheet, if one exists (admin page → Regional
//         Reference Data). This is authoritative: when present, the provincial copies are ignored.
//      b. otherwise the first province file, in fixed slot order, that supplies the sheet.
//    Which source won is recorded in the notes, so the provenance of the denominators is always
//    visible rather than implicit.
//
// Regional rates are then computed by the pipeline from summed numerators over summed denominators,
// which is why raw rows are merged rather than each province's finished percentages.
const { PROVINCE_SLOTS, PROVINCE_SHEETS, REGIONAL_SHEETS, referenceSlotForSheet } = require("./provinceTemplate");
const { getAllProvinceEntries, getAllReferenceEntries } = require("./provinceStore");
const { runPipelineOnWorkbook } = require("./pipeline");

/**
 * Pads every row to the same width, returning a plain rectangular array-of-arrays rather than a
 * real SheetJS Sheet object.
 *
 * WHY NOT XLSX.utils.aoa_to_sheet(): the pipeline (vendor/ntp_pipeline_browser.js) never reads a
 * sheet directly - every access goes through rawRows(), which itself calls
 * XLSX.utils.sheet_to_json(ws, {header:1}) to turn the sheet back into... an array-of-arrays. Since
 * gridToSheet's input is already an array-of-arrays, building a real Sheet here just to have
 * rawRows() convert it straight back is a pure round trip: it allocates one verbose {v,t,w,...}
 * cell object per cell (aoa_to_sheet) and then a second fresh row-array per row (sheet_to_json) for
 * no benefit, roughly doubling both the time and memory this step costs. At full-region scale
 * (~120k merged rows across sheets) that round trip alone was measured at +127MB RSS.
 * rawRows() is taught to recognise this plain-array shape and use it directly (see its comment),
 * so skipping straight to the padded array here is safe and produces byte-identical KPI output -
 * verified against the previous aoa_to_sheet path on a full synthetic regional dataset.
 */
function gridToSheet(grid) {
  if (!grid || !grid.length) return [[]];
  let width = 0;
  for (const r of grid) if (r && r.length > width) width = r.length;
  return grid.map((r) => {
    const row = (r || []).slice(0, width);
    while (row.length < width) row.push(null);
    return row;
  });
}

/**
 * @param {object} provinceEntries  { PROVINCE_ID: entry|null }
 * @param {object} [referenceEntries] { SLOT_ID: entry|null } - dedicated region-wide uploads.
 *        Omitted (or empty) means "none uploaded", and the region-wide sheets fall back to the
 *        provincial copies exactly as before.
 * @returns {{workbook, presentProvinces, missingProvinces, sheetRowCounts, notes}}
 */
function buildConsolidatedWorkbook(provinceEntries, referenceEntries) {
  referenceEntries = referenceEntries || {};
  const workbook = { SheetNames: [], Sheets: {} };
  const presentProvinces = [];
  const missingProvinces = [];
  const sheetRowCounts = {};
  const notes = [];

  for (const slot of PROVINCE_SLOTS) {
    const entry = provinceEntries[slot.id];
    if (entry && entry.sheets) presentProvinces.push(slot.id);
    else missingProvinces.push(slot.id);
  }

  // ---- 1. province-scoped sheets: header block once, then every province's data rows ----
  for (const spec of PROVINCE_SHEETS) {
    let header = null;
    const dataRows = [];
    for (const provinceId of presentProvinces) {
      const stored = provinceEntries[provinceId].sheets[spec.canonical];
      if (!stored || !stored.grid || !stored.grid.length) continue;
      const grid = stored.grid;
      const hr = typeof stored.headerRows === "number" ? stored.headerRows : spec.headerRows;
      if (!header) header = grid.slice(0, hr);
      const body = grid.slice(hr);
      if (body.length) dataRows.push(...body);
    }
    if (!header && !dataRows.length) continue;
    const grid = (header || []).concat(dataRows);
    if (!grid.length) continue;
    workbook.SheetNames.push(spec.canonical);
    workbook.Sheets[spec.canonical] = gridToSheet(grid);
    sheetRowCounts[spec.canonical] = dataRows.length;
  }

  // ---- 2. region-wide sheets: exactly one copy, dedicated upload winning over provincial ----
  for (const spec of REGIONAL_SHEETS) {
    let stored = null;
    let source = null;

    // (a) a dedicated regional upload is authoritative.
    const refSlot = referenceSlotForSheet(spec.canonical);
    if (refSlot) {
      const refEntry = referenceEntries[refSlot.id];
      const candidate = refEntry && refEntry.sheets ? refEntry.sheets[spec.canonical] : null;
      if (candidate && candidate.grid && candidate.grid.length) {
        stored = candidate;
        source = `the ${refSlot.label} upload`;
      }
    }

    // (b) otherwise fall back to the first province file that carries it.
    if (!stored) {
      for (const provinceId of presentProvinces) {
        const entry = provinceEntries[provinceId];
        const candidate = entry.regionalSheets ? entry.regionalSheets[spec.canonical] : null;
        if (candidate && candidate.grid && candidate.grid.length) {
          stored = candidate;
          source = `${provinceId}'s file`;
          break;
        }
      }
    }
    if (!stored) continue;

    notes.push(`"${spec.label}" (region-wide reference) taken from ${source}.`);
    workbook.SheetNames.push(spec.canonical);
    workbook.Sheets[spec.canonical] = gridToSheet(stored.grid);
    const hr = typeof stored.headerRows === "number" ? stored.headerRows : spec.headerRows;
    sheetRowCounts[spec.canonical] = Math.max(0, stored.grid.length - hr);
    sheetRowCounts[spec.canonical + " (source)"] = source;
  }

  return { workbook, presentProvinces, missingProvinces, sheetRowCounts, notes };
}

/** Returns true when the built workbook has a usable POPULATION sheet. */
function hasPopulation(workbook) {
  return workbook.SheetNames.includes("POPULATION");
}

/**
 * Full consolidation: read every slot -> merge -> recompute KPIs.
 * Throws rather than publishing a partial dataset, so the caller can leave the live dashboard alone.
 *
 * @param {(msg: string) => void} [onProgress]
 * @param {{province?: object, reference?: object}} [overrides] - the entry a caller JUST wrote (or
 *        deleted - use null) for a specific slot, keyed by id. Blob storage's put()/del() are not
 *        guaranteed to be visible to an immediately-following get() from the same request - without
 *        this, a province upload can race its own write and consolidate as if the file just saved
 *        were never there ("No province files have been uploaded yet"), and a delete can race its
 *        own removal and consolidate the just-deleted file right back in. Overrides make the entry
 *        this request itself just wrote authoritative for this one consolidation, regardless of
 *        what the store's read-back says; every other slot is still read fresh as normal.
 */
async function consolidate(onProgress, overrides) {
  const notify = onProgress || (() => {});
  const log = [];
  const say = (m) => { log.push(m); notify(m); };

  say("Reading province datasets...");
  const provinceEntries = await getAllProvinceEntries();
  const referenceEntries = await getAllReferenceEntries();
  if (overrides && overrides.province) {
    for (const id in overrides.province) provinceEntries[id] = overrides.province[id];
  }
  if (overrides && overrides.reference) {
    for (const id in overrides.reference) referenceEntries[id] = overrides.reference[id];
  }

  const built = buildConsolidatedWorkbook(provinceEntries, referenceEntries);
  // POPULATION is the real gate, not "at least one province has case data": the region-wide
  // reference (Population, Facility List) is legitimately uploaded on its own, independently of any
  // province's case files, and the pipeline already renders a complete, honest shell from it alone -
  // every case count is a real, un-fabricated 0 (nothing has been reported yet), not an estimate.
  // Previously this threw "no province files" BEFORE ever checking population, which meant a
  // Population-only reference upload was rejected outright with a confusing "nothing to consolidate"
  // error, even though it was itself perfectly valid and sufficient to publish a shell dashboard.
  if (!hasPopulation(built.workbook)) {
    // NOT_READY marks this as an EXPECTED, benign state - "there just isn't enough uploaded yet to
    // publish anything" - as opposed to a genuine pipeline failure. Callers (province-upload.js,
    // reference-upload.js) use this to decide whether a file that otherwise validated cleanly should
    // still be KEPT even though nothing could be published from it yet, rather than treated as
    // rejected and rolled back. An admin uploading Facility List (or a province's case file) before
    // Population exists is doing nothing wrong - the file is good, there's just no denominator to
    // compute rates against yet.
    if (!built.presentProvinces.length) {
      const err = new Error("No province files have been uploaded yet - nothing to consolidate.");
      err.code = "NOT_READY";
      throw err;
    }
    const err = new Error(
      "No POPULATION sheet is available. Upload one to the Population slot under Regional Reference " +
      "Data, or include a POPULATION sheet in a province file. Population figures are the " +
      "denominators for every rate, so KPIs cannot be computed without them."
    );
    err.code = "NOT_READY";
    throw err;
  }

  say(
    `Merged ${built.presentProvinces.length} area(s): ${built.presentProvinces.join(", ")}.` +
    (built.missingProvinces.length ? ` Awaiting: ${built.missingProvinces.join(", ")}.` : "")
  );
  built.notes.forEach(say);

  // Every row in this workbook carries the Province of the slot it was uploaded to (stamped by
  // validateProvinceUpload). That ownership is authoritative: the pipeline must not re-assign cases
  // to a different province based on their facility, or a province's own submission would end up
  // counted somewhere else - and rows whose corrected value matched no slot would vanish from the
  // province totals while still counting regionally.
  built.workbook.__trustProvinceColumn = true;

  say("Recomputing KPIs over the consolidated workbook...");
  const kpi = runPipelineOnWorkbook(built.workbook, (m) => say(m));

  kpi.meta = kpi.meta || {};
  kpi.meta.consolidation = {
    provincesPresent: built.presentProvinces,
    provincesMissing: built.missingProvinces,
    consolidatedAt: new Date().toISOString(),
    sheetRowCounts: built.sheetRowCounts,
    notes: built.notes,
  };

  say("Consolidation complete.");
  return {
    kpi,
    presentProvinces: built.presentProvinces,
    missingProvinces: built.missingProvinces,
    sheetRowCounts: built.sheetRowCounts,
    notes: built.notes,
    log,
  };
}

module.exports = { buildConsolidatedWorkbook, consolidate };
