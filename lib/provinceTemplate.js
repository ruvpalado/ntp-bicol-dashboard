// Per-province upload template - modelled directly on Format.xlsx, the workbook provinces are
// required to follow. All 13 sheets of that file are recognised here under their exact names
// (note the deliberate odd whitespace: "CNR 2026 " and "Facility List " have trailing spaces,
// "TSR  COHORT" has a double space - the pipeline looks these up verbatim).
//
// WHY RAW GRIDS, NOT PARSED OBJECTS: several sheets in Format.xlsx are cross-tab reports with
// two or three stacked header rows (SCREENING PRESUMPTIVE, SPUTUM/STOOL EXAMINATION, PARAGO,
// GENXPERT), and POPULATION is a hierarchical Region -> Province -> Municipality -> Barangay grid
// that the pipeline reads positionally with forward-fill. Parsing those into flat objects would
// destroy the structure the pipeline depends on. So every sheet is stored as its raw cell grid
// (array of arrays) together with how many leading rows are header, and consolidation keeps one
// copy of the header block and concatenates only the data rows underneath.
//
// The headerRows values below MUST match how ntp_pipeline_browser.js reads each sheet:
//   objRows(wb, name, 0)      -> headerRows 1     (CNR/MN/TPT/TSR COHORT/TPT COHORT)
//   objRows(wb, name, 1)      -> headerRows 2     (GENXPERT RESULT RELEASED)
//   rawRows(wb, name).slice(2)-> headerRows 2     (POPULATION CATCHMENT, SCREENING PRESUMPTIVE)
//   rawRows(wb, name).slice(3)-> headerRows 3     (SPUTUM, STOOL BASE, PARAGO)
const XLSX = require("xlsx");
const { coerceDateValue } = require("./pipeline");

const PROVINCE_SLOTS = [
  { id: "ALBAY", label: "Albay" },
  { id: "CAMARINES NORTE", label: "Camarines Norte" },
  { id: "CAMARINES SUR", label: "Camarines Sur" },
  { id: "CATANDUANES", label: "Catanduanes" },
  { id: "MASBATE", label: "Masbate" },
  { id: "SORSOGON", label: "Sorsogon" },
  { id: "NAGA CITY", label: "Naga City" },
];

// scope:
//   "province" - holds that area's own records; concatenated across provinces on consolidation.
//   "regional" - region-wide reference data; taken from ONE source, never concatenated (doing so
//                would multiply the population denominators by the number of uploading provinces).
// Data-type rules, scoped deliberately narrowly to columns whose expected type is unambiguous AND
// directly grounded in how ntp_pipeline_browser.js actually reads them - not a guess:
//   dateColumns        - must coerce via the pipeline's own coerceDate() (shared, see lib/pipeline.js).
//   numericColumns      - must be a finite number (numeric string accepted, matching the pipeline's
//                         own tolerant `isNaN()` checks e.g. in ageBand()).
//   categoricalColumns  - must exactly match one of the listed values, IF present. Only added for
//                         columns the pipeline compares with strict `===` to filter rows (CNR's
//                         Type -> DSTB/DRTB at lines ~2625-2628; TSR COHORT's Type -> DS/DR/MN at
//                         ~2787-2858) - an unrecognised value there doesn't error, it just silently
//                         drops out of every filter that checks it, undercounting real patients.
//                         Sex/Outcome/Status/Bacteriological Status/Registration Group etc. are
//                         deliberately NOT constrained here: Format.xlsx carries no data-validation
//                         dropdown lists to confirm an authoritative value set for them, and guessing
//                         one risks rejecting real, valid data on a wrong assumption.
// A blank/missing cell is NOT a type error (that's a completeness concern, handled separately) - only
// a NON-BLANK value that fails to parse/match triggers a rejection.
const SHEET_SPECS = [
  { canonical: "CNR 2026 ", label: "CNR 2026", aliases: ["cnr 2026", "cnr"], scope: "province",
    required: true, headerRows: 1,
    requiredColumns: ["Date of Notification", "Province", "Screening/Diagnosing Health Facility"],
    dateColumns: ["Date of Notification"], numericColumns: ["Age"],
    categoricalColumns: { "Type": ["DSTB", "DRTB"] } },

  { canonical: "MN 2026", label: "MN 2026", aliases: ["mn 2026"], scope: "province",
    required: false, headerRows: 1,
    requiredColumns: ["Date of Diagnosis", "Province", "Screening/Diagnosing Health Facility"],
    dateColumns: ["Date of Diagnosis"], numericColumns: ["Age"] },

  { canonical: "TPT 2026", label: "TPT 2026", aliases: ["tpt 2026", "tpt"], scope: "province",
    required: false, headerRows: 1,
    requiredColumns: ["Date of Notification", "Province", "Screening/Diagnosing Health Facility"],
    dateColumns: ["Date of Notification"], numericColumns: ["Age"] },

  { canonical: "TSR  COHORT", label: "TSR COHORT", aliases: ["tsr cohort", "tsr"], scope: "province",
    required: false, headerRows: 1,
    requiredColumns: ["Date of Notification", "Province", "Treatment Health Facility"],
    dateColumns: ["Date of Notification"],
    categoricalColumns: { "Type": ["DS", "DR", "MN"] } },

  { canonical: "TPT COHORT", label: "TPT COHORT", aliases: ["tpt cohort"], scope: "province",
    required: false, headerRows: 1,
    requiredColumns: ["Date of Notification", "Province", "Treatment Health Facility"],
    dateColumns: ["Date of Notification"] },

  { canonical: "SCREENING PRESUMPTIVE", label: "SCREENING PRESUMPTIVE", aliases: ["screening presumptive", "screening"],
    scope: "province", required: false, headerRows: 2, requiredColumns: [] },

  { canonical: "SPUTUM EXAMINATION", label: "SPUTUM EXAMINATION", aliases: ["sputum examination", "dssm"],
    scope: "province", required: false, headerRows: 3, requiredColumns: [] },

  { canonical: "STOOL BASE EXAMINATION", label: "STOOL BASE EXAMINATION", aliases: ["stool base examination", "stool"],
    scope: "province", required: false, headerRows: 3, requiredColumns: [] },

  { canonical: "GENXPERT RESULT RELEASED", label: "GENXPERT RESULT RELEASED", aliases: ["genxpert result released", "genxpert"],
    scope: "province", required: false, headerRows: 2, requiredColumns: [] },

  { canonical: "PARAGO CASE EXAMINATION", label: "PARAGO CASE EXAMINATION", aliases: ["parago case examination", "parago"],
    scope: "province", required: false, headerRows: 3, requiredColumns: [] },

  // Long/tidy format only (Region/Province-HUC/.../Value, 1 header row) - same layout as the 5 report
  // sheets above. Feeds DSSM Examination's "Follow-up" figure (Laboratory module) and the PICT
  // Examination module respectively; both were previously unwired placeholders.
  { canonical: "Table E - Treatment Follow-up", label: "Treatment Follow-up",
    aliases: ["table e - treatment follow-up", "treatment follow-up", "table e"],
    scope: "province", required: false, headerRows: 1, requiredColumns: [] },

  { canonical: "PICT", label: "PICT", aliases: ["pict"], scope: "province", required: false, headerRows: 1, requiredColumns: [] },

  // ---- region-wide reference sheets ----
  { canonical: "POPULATION", label: "POPULATION", aliases: ["population"], scope: "regional",
    required: false, headerRows: 0, requiredColumns: [] },

  // headerRows is 1 to match the current template (Province/Municipality/Facility/Population, one
  // header row, forward-filled block-style). The older 2-header-row Facility/Population-only layout
  // is still accepted - ntp_pipeline_browser.js locates the real header row by name at read time
  // rather than trusting this count, so this value only affects the admin's row-count display.
  { canonical: "POPULATION CATCHMENT", label: "POPULATION CATCHMENT", aliases: ["population catchment"],
    scope: "regional", required: false, headerRows: 1, requiredColumns: [] },

  { canonical: "Facility List ", label: "Facility List", aliases: ["facility list"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },

  // Newer roster layout: the same Province/Municipality/Facility Name/Type table split into 5
  // sheets by Type instead of one combined "Facility List " sheet - and each row carries its own
  // Province directly (no block forward-fill needed), which the old layout required. Any subset may
  // be present; ntp_pipeline_browser.js concatenates whichever of these show up. A facility can
  // legitimately appear in more than one (e.g. both IDOTS and RTDL) under differently-suffixed
  // names, matching how case-data sheets refer to the same physical site differently per program.
  { canonical: "IDOTS", label: "Facility List - IDOTS", aliases: ["idots"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },
  { canonical: "MN", label: "Facility List - MN", aliases: ["mn"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },
  { canonical: "PMDT", label: "Facility List - PMDT", aliases: ["pmdt"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },
  { canonical: "RTDL", label: "Facility List - RTDL", aliases: ["rtdl"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },
  { canonical: "TML", label: "Facility List - TML", aliases: ["tml"], scope: "regional",
    required: false, headerRows: 1, requiredColumns: [] },

  // Not present in Format.xlsx but supported if a workbook supplies it - the pipeline uses it for
  // facility -> province resolution and falls back gracefully when absent.
  { canonical: "TARGET 2026", label: "TARGET 2026", aliases: ["target 2026", "target"], scope: "regional",
    required: false, headerRows: 3, requiredColumns: [] },
];

const PROVINCE_SHEETS = SHEET_SPECS.filter((s) => s.scope === "province");
const REGIONAL_SHEETS = SHEET_SPECS.filter((s) => s.scope === "regional");
const ACCEPTED_EXTENSIONS = [".xlsx", ".xls", ".csv", ".json"];

/**
 * Region-wide reference data, uploaded once for the whole region rather than per province.
 *
 * These sheets describe the region, not any one area: POPULATION is the denominator behind every
 * rate on the dashboard, and the facility list resolves a treatment facility to its municipality
 * and province. Previously they were read from whichever provincial file happened to carry them
 * first, which made a shared denominator depend on upload order. A dedicated slot makes them
 * authoritative: when one is uploaded it is used region-wide and the provincial copies are ignored.
 *
 * `sheets` lists the canonical sheet names a slot owns, most important first - the first entry is
 * also what a single-table CSV upload is interpreted as.
 */
const REFERENCE_SLOTS = [
  {
    id: "POPULATION",
    label: "Population",
    sheets: ["POPULATION", "POPULATION CATCHMENT"],
    hint: "Region → province → municipality → barangay population grid. Supplies the denominator for every rate.",
  },
  {
    id: "FACILITY_LIST",
    label: "Facility List",
    sheets: ["Facility List ", "IDOTS", "MN", "PMDT", "RTDL", "TML"],
    hint: "Master list of treatment facilities. Resolves each facility to its municipality and province. Either one combined \"Facility List\" sheet, or separate IDOTS/MN/PMDT/RTDL/TML sheets - any subset of the latter is fine.",
  },
];

function findReferenceSlot(id) {
  const key = String(id || "").trim().toUpperCase();
  return REFERENCE_SLOTS.find((s) => s.id === key) || null;
}

/** The reference slot that owns a canonical sheet name, or null if no slot does. */
function referenceSlotForSheet(canonical) {
  return REFERENCE_SLOTS.find((s) => s.sheets.includes(canonical)) || null;
}

function normalizeSheetKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findProvince(id) {
  const key = String(id || "").trim().toUpperCase();
  return PROVINCE_SLOTS.find((p) => p.id === key) || null;
}

function findSpec(canonical) {
  return SHEET_SPECS.find((s) => s.canonical === canonical) || null;
}

/** canonical sheet name -> actual name in the uploaded workbook (case/whitespace tolerant). */
function matchSheets(workbookSheetNames, specs) {
  const byKey = new Map();
  for (const actual of workbookSheetNames) byKey.set(normalizeSheetKey(actual), actual);
  const found = new Map();
  for (const spec of specs) {
    const candidates = [normalizeSheetKey(spec.canonical), ...spec.aliases.map(normalizeSheetKey)];
    for (const c of candidates) {
      if (byKey.has(c)) { found.set(spec.canonical, byKey.get(c)); break; }
    }
  }
  return found;
}

/** Trailing all-blank rows carry no data and only bloat storage. */
function trimTrailingBlankRows(grid) {
  let end = grid.length;
  while (end > 0) {
    const row = grid[end - 1];
    const blank = !row || row.every((c) => c === null || c === undefined || String(c).trim() === "");
    if (!blank) break;
    end--;
  }
  return grid.slice(0, end);
}

/** Parses an uploaded file into { sheetName: rawGrid[][] }. */
function parseUpload(buffer, filename, opts) {
  const options = opts || {};
  const m = String(filename || "").toLowerCase().match(/\.[a-z]+$/);
  const extension = m ? m[0] : "";
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    const err = new Error(
      `Unsupported file type "${extension || "(none)"}". Accepted formats: ${ACCEPTED_EXTENSIONS.join(", ")}.`
    );
    err.code = "BAD_FORMAT";
    throw err;
  }

  if (extension === ".json") {
    let parsed;
    try { parsed = JSON.parse(buffer.toString("utf8")); }
    catch (e) {
      const err = new Error("File is not valid JSON: " + e.message);
      err.code = "BAD_FORMAT"; throw err;
    }
    const out = {};
    if (Array.isArray(parsed)) {
      out[options.singleSheet || PROVINCE_SHEETS[0].canonical] = parsed;
    } else if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) out[k] = v;
    } else {
      const err = new Error('JSON must be { "SHEET NAME": [[row cells]] } or a single array of rows.');
      err.code = "BAD_FORMAT"; throw err;
    }
    // Accept arrays of objects too, by flattening them to a grid with a header row.
    for (const [k, rows] of Object.entries(out)) {
      if (rows.length && !Array.isArray(rows[0]) && typeof rows[0] === "object") {
        const header = Object.keys(rows[0]);
        out[k] = [header].concat(rows.map((r) => header.map((h) => (r[h] === undefined ? null : r[h]))));
      }
    }
    return out;
  }

  let workbook;
  try { workbook = XLSX.read(buffer, { type: "buffer", cellDates: true }); }
  catch (e) {
    const err = new Error("Could not read the file as a spreadsheet: " + e.message);
    err.code = "BAD_FORMAT"; throw err;
  }

  const out = {};
  if (extension === ".csv") {
    if (!options.singleSheet) {
      const err = new Error("A CSV holds only one table, so the sheet it represents must be chosen before uploading.");
      err.code = "CSV_SHEET_REQUIRED"; throw err;
    }
    const first = workbook.SheetNames[0];
    out[options.singleSheet] = trimTrailingBlankRows(
      XLSX.utils.sheet_to_json(workbook.Sheets[first], { header: 1, defval: null, raw: true })
    );
    return out;
  }

  for (const name of workbook.SheetNames) {
    out[name] = trimTrailingBlankRows(
      XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: true })
    );
  }
  return out;
}

function headerCells(grid, spec) {
  const idx = Math.max(0, spec.headerRows - 1);
  const row = grid[idx] || [];
  return row.map((c) => (c === null || c === undefined ? "" : String(c).trim()));
}

/** True if a raw cell value should count as present (not blank) for type-checking purposes. */
function isPresent(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/**
 * Checks the VALUES within a sheet's date/numeric/categorical columns, not just that the column
 * headers exist. A blank cell is not a type error (that's completeness, not type) - only a non-blank
 * value that fails to parse/match is reported. Caps each column's reported bad rows at 5 concrete
 * examples (row number + raw value + its JS type) so a systemic problem (e.g. an entire column
 * formatted as text) is immediately actionable rather than just a bare count, mirroring how the
 * pipeline's own TSR Cohort date diagnostic (ntp_pipeline_browser.js) reports bad dates.
 * @returns {string[]} error messages, empty if the sheet's typed columns are all clean
 */
function validateDataTypes(grid, spec) {
  const errors = [];
  const header = headerCells(grid, spec);
  const colIndex = (name) => header.indexOf(name);

  function collect(columns, check, kindLabel) {
    for (const colName of columns || []) {
      const idx = colIndex(colName);
      if (idx === -1) continue; // required-column check already reports a missing column; don't double up
      const bad = [];
      let badCount = 0;
      for (let i = spec.headerRows; i < grid.length; i++) {
        const row = grid[i];
        if (!row) continue;
        const raw = row[idx];
        if (!isPresent(raw)) continue; // blank = missing, not a type error
        if (check(raw)) continue; // valid
        badCount++;
        if (bad.length < 5) {
          bad.push(`row ${i + 1}: ${JSON.stringify(raw)} (${typeof raw})`);
        }
      }
      if (badCount) {
        errors.push(
          `Sheet "${spec.label}", column "${colName}": ${badCount} row(s) have a value that is not a valid ${kindLabel}. ` +
          `Example(s): ${bad.join("; ")}${badCount > bad.length ? ", ..." : ""}.`
        );
      }
    }
  }

  collect(spec.dateColumns, (raw) => coerceDateValue(raw) !== null, "date");
  collect(spec.numericColumns, (raw) => typeof raw === "number" ? isFinite(raw) : isFinite(Number(String(raw).trim())), "number");
  if (spec.categoricalColumns) {
    for (const [colName, allowed] of Object.entries(spec.categoricalColumns)) {
      const allowedSet = new Set(allowed);
      collect([colName], (raw) => allowedSet.has(String(raw).trim()), `value (expected one of: ${allowed.join(", ")})`);
    }
  }

  return errors;
}

/**
 * Locates the Province column. The cross-tab report sheets (SPUTUM/STOOL/PARAGO/GENXPERT) put
 * "Province" on an EARLIER header row than the one carrying the data-column labels, so scanning
 * only the last header row misses it - which would silently skip province stamping on exactly the
 * sheets where a mislabelled row is hardest to spot. Scan every header row instead.
 * @returns {number} column index, or -1
 */
function findProvinceColumn(grid, spec) {
  const rows = Math.max(1, spec.headerRows);
  for (let r = 0; r < rows && r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      if (String(v).trim().toLowerCase().replace(/\s+/g, " ") === "province") return c;
    }
  }
  return -1;
}

/**
 * Validates an uploaded province workbook against the Format.xlsx layout.
 * @returns {{ok, errors, warnings, sheets, rowCounts, regionalSheets}}
 *   sheets          - province-scoped sheets as { canonical: { headerRows, grid } }
 *   regionalSheets  - region-wide sheets found in this file (kept aside, used only as a fallback
 *                     when no regional master has been uploaded)
 */
function validateProvinceUpload(parsedSheets, provinceId) {
  const errors = [];
  const warnings = [];
  const province = findProvince(provinceId);
  if (!province) {
    return { ok: false, errors: [`Unknown province slot "${provinceId}".`], warnings: [],
             sheets: {}, rowCounts: {}, regionalSheets: {} };
  }

  const present = matchSheets(Object.keys(parsedSheets), SHEET_SPECS);
  const sheets = {};
  const rowCounts = {};
  const regionalSheets = {};

  for (const spec of SHEET_SPECS) {
    const actualName = present.get(spec.canonical);
    if (!actualName) {
      if (spec.required) {
        errors.push(`Missing required sheet "${spec.label}". Use the Format.xlsx layout - download the template above.`);
      }
      continue;
    }
    const grid = parsedSheets[actualName] || [];
    const dataRows = Math.max(0, grid.length - spec.headerRows);

    if (spec.scope === "regional") {
      if (dataRows > 0) regionalSheets[spec.canonical] = { headerRows: spec.headerRows, grid };
      continue;
    }

    if (grid.length < spec.headerRows) {
      warnings.push(`Sheet "${spec.label}" has no header rows; it was skipped.`);
      continue;
    }

    // Schema check against the sheet's real header row.
    if (spec.requiredColumns.length) {
      const cols = headerCells(grid, spec);
      const colSet = new Set(cols);
      const missing = spec.requiredColumns.filter((c) => !colSet.has(c));
      if (missing.length) {
        errors.push(
          `Sheet "${spec.label}" is missing required column(s): ${missing.join(", ")}. ` +
          `Found: ${cols.filter(Boolean).slice(0, 8).join(", ")}${cols.filter(Boolean).length > 8 ? ", ..." : ""}.`
        );
        continue;
      }
    }

    if (dataRows === 0) {
      warnings.push(`Sheet "${spec.label}" contains no data rows.`);
      sheets[spec.canonical] = { headerRows: spec.headerRows, grid: grid.slice(0, spec.headerRows) };
      rowCounts[spec.canonical] = 0;
      continue;
    }

    // Data-type check against the sheet's actual cell VALUES (dates, numbers, and the handful of
    // strictly-compared category columns) - distinct from the column-header check above. A file that
    // has the right columns but garbage in them (e.g. dates stored as unformatted text) is rejected
    // here with the specific bad rows named, rather than silently publishing and surfacing the
    // problem later as a buried data-quality note (see HANDOVER.md, Camarines Norte TSR Cohort dates).
    const typeErrors = validateDataTypes(grid, spec);
    if (typeErrors.length) {
      errors.push(...typeErrors);
      continue;
    }

    // Stamp the Province column from the slot this file was uploaded to, so a mislabelled row
    // can't leak into another area's figures. Only applies to sheets that have a Province column.
    const provIdx = findProvinceColumn(grid, spec);
    if (provIdx !== -1) {
      let relabelled = 0;
      for (let i = spec.headerRows; i < grid.length; i++) {
        const row = grid[i];
        if (!row) continue;
        const existing = row[provIdx] === null || row[provIdx] === undefined ? "" : String(row[provIdx]).trim();
        // Blank cells are normal here (the source files forward-fill province down the column),
        // so only count a genuine mismatch.
        if (existing && existing.toUpperCase() !== province.id) relabelled++;
        row[provIdx] = province.id;
      }
      if (relabelled) {
        warnings.push(
          `Sheet "${spec.label}": ${relabelled} row(s) named a different province; all rows were set to ` +
          `${province.label} (the slot this file was uploaded to).`
        );
      }
    }

    sheets[spec.canonical] = { headerRows: spec.headerRows, grid };
    rowCounts[spec.canonical] = dataRows;
  }

  const total = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  if (!errors.length && total === 0) {
    errors.push("The file contains no data rows in any recognised sheet.");
  }

  return { ok: errors.length === 0, errors, warnings, sheets, rowCounts, regionalSheets };
}

/**
 * Validates an uploaded region-wide reference workbook (Population or Facility List).
 *
 * Deliberately more permissive than the province validator: these sheets have no Province column to
 * stamp and no per-area ownership, so the only real requirement is that the file actually contains
 * at least one of the sheets the slot owns, with data rows in it. Sheets belonging to OTHER slots
 * are ignored rather than rejected - a user uploading the full Format.xlsx to the Population slot
 * should get the population data out of it, not an error.
 *
 * @returns {{ok, errors, warnings, sheets, rowCounts}}
 */
function validateReferenceUpload(parsedSheets, slotId) {
  const errors = [];
  const warnings = [];
  const slot = findReferenceSlot(slotId);
  if (!slot) {
    return { ok: false, errors: [`Unknown reference slot "${slotId}".`], warnings: [], sheets: {}, rowCounts: {} };
  }

  const ownedSpecs = slot.sheets.map(findSpec).filter(Boolean);
  const present = matchSheets(Object.keys(parsedSheets), ownedSpecs);
  const sheets = {};
  const rowCounts = {};

  for (const spec of ownedSpecs) {
    const actualName = present.get(spec.canonical);
    if (!actualName) continue;
    const grid = parsedSheets[actualName] || [];
    const dataRows = Math.max(0, grid.length - spec.headerRows);
    if (dataRows === 0) {
      warnings.push(`Sheet "${spec.label}" was found but contains no data rows; it was skipped.`);
      continue;
    }
    sheets[spec.canonical] = { headerRows: spec.headerRows, grid };
    rowCounts[spec.canonical] = dataRows;
  }

  if (!Object.keys(sheets).length) {
    const wanted = ownedSpecs.map((s) => `"${s.label}"`).join(" or ");
    const found = Object.keys(parsedSheets).filter(Boolean).slice(0, 8);
    errors.push(
      `No ${wanted} sheet with data rows was found in this file. ` +
      (found.length ? `Sheets in the file: ${found.join(", ")}${Object.keys(parsedSheets).length > 8 ? ", ..." : ""}.`
                    : "The file appears to be empty.")
    );
  }

  // Worth saying out loud rather than silently half-succeeding.
  if (!errors.length && ownedSpecs.length > 1) {
    const missing = ownedSpecs.filter((s) => !sheets[s.canonical]).map((s) => `"${s.label}"`);
    if (missing.length) {
      warnings.push(
        `${missing.join(" and ")} was not in this file, so any previously uploaded copy is no longer used. ` +
        `Upload a workbook containing every sheet this slot owns if you need them together.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, sheets, rowCounts };
}

module.exports = {
  PROVINCE_SLOTS,
  REFERENCE_SLOTS,
  SHEET_SPECS,
  PROVINCE_SHEETS,
  REGIONAL_SHEETS,
  ACCEPTED_EXTENSIONS,
  findProvince,
  findReferenceSlot,
  referenceSlotForSheet,
  findSpec,
  matchSheets,
  normalizeSheetKey,
  findProvinceColumn,
  parseUpload,
  validateProvinceUpload,
  validateReferenceUpload,
};
