// End-to-end test for the Admin Page Upload & Consolidation feature, driven by the REAL
// Format.xlsx layout that provinces are required to follow.
//
// Uses an in-memory stand-in for Vercel Blob so the actual validation, isolation, consolidation
// and rollback logic all run for real without needing a cloud store.
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

// ---------------------------------------------------------------- in-memory blob stub
const BLOB = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(pathname) {
        if (!BLOB.has(pathname)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        const text = BLOB.get(pathname);
        return { statusCode: 200, stream: { text: async () => text }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(pathname, body) { BLOB.set(pathname, String(body)); return { url: "memory://" + pathname }; },
      async del(pathname) { BLOB.delete(pathname); },
    };
  }
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const template = require(BASE + "lib/provinceTemplate");
const store = require(BASE + "lib/provinceStore");
const consolidator = require(BASE + "lib/consolidate");

const FORMAT_PATH = BASE + "test_fixtures_Format.xlsx";
const formatBuffer = fs.readFileSync(FORMAT_PATH);

const results = [];
const check = (name, fn) => Promise.resolve().then(fn)
  .then((r) => results.push([name, r !== false, r === false ? "returned false" : ""]))
  .catch((e) => results.push([name, false, e.message]));

// ---------------------------------------------------------------- fixtures
// Build a province file that follows Format.xlsx exactly: same sheets, same header blocks,
// with synthetic data rows appended for that province.
function provinceFileFromFormat(province, cnrRows) {
  const parsed = template.parseUpload(formatBuffer, "Format.xlsx");
  const out = {};
  for (const [name, grid] of Object.entries(parsed)) out[name] = grid.map((r) => (r ? r.slice() : r));

  const spec = template.findSpec("CNR 2026 ");
  const cnr = out["CNR 2026 "];
  const header = cnr[0].map((c) => (c === null ? "" : String(c).trim()));
  const dateIdx = header.indexOf("Date of Notification");
  const provIdx = header.indexOf("Province");
  const facIdx = header.indexOf("Screening/Diagnosing Health Facility");
  const muniIdx = header.indexOf("City/Municipality");

  const grid = cnr.slice(0, spec.headerRows);
  for (let i = 0; i < cnrRows; i++) {
    const row = new Array(header.length).fill(null);
    row[dateIdx] = "2026-0" + ((i % 9) + 1) + "-15";
    row[provIdx] = province;
    row[muniIdx] = province + " CITY";
    row[facIdx] = province + " HEALTH CENTER";
    grid.push(row);
  }
  out["CNR 2026 "] = grid;
  return out;
}

function toBuffer(parsedSheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, grid] of Object.entries(parsedSheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid.length ? grid : [[]]), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function storeProvince(province, cnrRows) {
  const parsed = provinceFileFromFormat(province, cnrRows);
  const res = template.validateProvinceUpload(parsed, province);
  if (!res.ok) throw new Error(province + " fixture invalid: " + res.errors.join("; "));
  await store.saveProvinceEntry(province, {
    provinceId: province, sheets: res.sheets, rowCounts: res.rowCounts,
    regionalSheets: res.regionalSheets,
    meta: { filename: province + ".xlsx", uploadedBy: "Tester", uploadedAt: new Date().toISOString() },
  });
  return res;
}

(async function run() {
  // ================================================================ template matches Format.xlsx
  await check("all 7 upload slots exist (6 provinces + Naga City)", () => {
    const ids = template.PROVINCE_SLOTS.map((s) => s.id);
    return ids.length === 7 && ids.includes("NAGA CITY") && ids.includes("ALBAY")
        && ids.includes("CAMARINES NORTE") && ids.includes("CAMARINES SUR")
        && ids.includes("CATANDUANES") && ids.includes("MASBATE") && ids.includes("SORSOGON");
  });

  await check("every sheet in Format.xlsx is recognised by the template", () => {
    const wb = XLSX.read(formatBuffer, { type: "buffer" });
    const matched = template.matchSheets(wb.SheetNames, template.SHEET_SPECS);
    const unmatched = wb.SheetNames.filter((n) =>
      ![...matched.values()].includes(n));
    if (unmatched.length) throw new Error("unrecognised sheets: " + unmatched.join(", "));
    return matched.size >= 13;
  });

  await check("odd sheet names from Format.xlsx are preserved verbatim", () => {
    const names = template.SHEET_SPECS.map((s) => s.canonical);
    return names.includes("CNR 2026 ")       // trailing space
        && names.includes("TSR  COHORT")     // double space
        && names.includes("Facility List "); // trailing space
  });

  await check("header-row offsets match how the pipeline reads each sheet", () => {
    // POPULATION CATCHMENT is intentionally excluded here: the pipeline locates its header row
    // dynamically (by finding a row that names both a Facility and a Population column) rather than
    // trusting a fixed offset, precisely so it keeps working whether a workbook uses the older
    // Facility/Population-only layout (2 header rows) or the current Province/Municipality/
    // Facility/Population layout (1 header row). This spec's headerRows value only drives the
    // admin's row-count display for whichever layout is uploaded, so there's no single fixed number
    // for this test to assert against.
    const expect = {
      "CNR 2026 ": 1, "MN 2026": 1, "TPT 2026": 1, "TSR  COHORT": 1, "TPT COHORT": 1,
      "GENXPERT RESULT RELEASED": 2, "SCREENING PRESUMPTIVE": 2,
      "SPUTUM EXAMINATION": 3, "STOOL BASE EXAMINATION": 3, "PARAGO CASE EXAMINATION": 3,
    };
    for (const [name, rows] of Object.entries(expect)) {
      const spec = template.findSpec(name);
      if (!spec) throw new Error("no spec for " + name);
      if (spec.headerRows !== rows) throw new Error(name + " headerRows=" + spec.headerRows + " expected " + rows);
    }
    return true;
  });

  await check("a genuine Format.xlsx file validates cleanly", () => {
    const parsed = provinceFileFromFormat("ALBAY", 5);
    const res = template.validateProvinceUpload(parsed, "ALBAY");
    if (!res.ok) throw new Error(res.errors.join("; "));
    return res.rowCounts["CNR 2026 "] === 5;
  });

  await check("region-wide sheets are separated out, not treated as province data", () => {
    const parsed = provinceFileFromFormat("ALBAY", 3);
    const res = template.validateProvinceUpload(parsed, "ALBAY");
    return !!res.regionalSheets["POPULATION"]
        && !res.sheets["POPULATION"]
        && !!res.regionalSheets["Facility List "];
  });

  // ================================================================ format + schema validation
  await check("rejects an unsupported file type", () => {
    try { template.parseUpload(Buffer.from("x"), "data.txt"); return false; }
    catch (e) { return e.code === "BAD_FORMAT" && /Accepted formats/.test(e.message); }
  });

  await check("rejects malformed JSON with a clear message", () => {
    try { template.parseUpload(Buffer.from("{nope"), "data.json"); return false; }
    catch (e) { return e.code === "BAD_FORMAT" && /not valid JSON/.test(e.message); }
  });

  await check("CSV without a nominated sheet is rejected with guidance", () => {
    try { template.parseUpload(Buffer.from("a,b\n1,2"), "x.csv"); return false; }
    catch (e) { return e.code === "CSV_SHEET_REQUIRED"; }
  });

  await check("schema check rejects a missing required column", () => {
    const parsed = provinceFileFromFormat("ALBAY", 2);
    // drop the "Date of Notification" column header
    const h = parsed["CNR 2026 "][0];
    h[h.findIndex((c) => String(c).trim() === "Date of Notification")] = "Something Else";
    const res = template.validateProvinceUpload(parsed, "ALBAY");
    return !res.ok && /missing required column/i.test(res.errors.join(" "))
        && /Date of Notification/.test(res.errors.join(" "));
  });

  await check("rejects a workbook with no recognised sheets", () => {
    const res = template.validateProvinceUpload({ "RANDOM": [["a"], [1]] }, "ALBAY");
    return !res.ok && /Missing required sheet/.test(res.errors.join(" "));
  });

  await check("unknown province slot is rejected", () => {
    const res = template.validateProvinceUpload({}, "NOT A PROVINCE");
    return !res.ok && /Unknown province slot/.test(res.errors[0]);
  });

  await check("sheet names match case/whitespace-insensitively", () => {
    const parsed = provinceFileFromFormat("ALBAY", 2);
    parsed["cnr 2026"] = parsed["CNR 2026 "]; delete parsed["CNR 2026 "];
    const res = template.validateProvinceUpload(parsed, "ALBAY");
    return res.ok && res.rowCounts["CNR 2026 "] === 2;
  });

  await check("rows naming another province are relabelled to the slot, with a warning", () => {
    const parsed = provinceFileFromFormat("MASBATE", 3);          // says MASBATE
    const res = template.validateProvinceUpload(parsed, "ALBAY"); // uploaded to ALBAY
    const spec = template.findSpec("CNR 2026 ");
    const grid = res.sheets["CNR 2026 "].grid;
    const header = grid[0].map((c) => (c === null ? "" : String(c).trim()));
    const pi = header.indexOf("Province");
    const allAlbay = grid.slice(spec.headerRows).every((r) => r[pi] === "ALBAY");
    return res.ok && allAlbay && res.warnings.some((w) => /different province/i.test(w));
  });

  // ================================================================ isolation
  await check("uploading one province leaves the other six untouched", async () => {
    BLOB.clear();
    await storeProvince("ALBAY", 6);
    const all = await store.getAllProvinceEntries();
    const others = Object.keys(all).filter((k) => k !== "ALBAY");
    return !!all["ALBAY"] && others.length === 6 && others.every((k) => all[k] === null);
  });

  await check("each area writes to its own blob path", () => {
    return store.provincePathname("ALBAY") !== store.provincePathname("MASBATE")
        && store.provincePathname("NAGA CITY") === "ntp-province/NAGA_CITY.json";
  });

  await check("re-uploading replaces that province rather than appending", async () => {
    await storeProvince("ALBAY", 9);
    const e = await store.getProvinceEntry("ALBAY");
    return e.rowCounts["CNR 2026 "] === 9;
  });

  // ================================================================ consolidation
  await check("consolidation concatenates province rows under one header block", async () => {
    await storeProvince("MASBATE", 4);
    const entries = await store.getAllProvinceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries);
    const spec = template.findSpec("CNR 2026 ");
    // buildConsolidatedWorkbook's Sheets values are plain array-of-arrays grids, not real SheetJS
    // Sheet objects (see lib/consolidate.js's gridToSheet) - the pipeline reads them the same way
    // via rawRows(), so tests read them directly too rather than round-tripping through XLSX utils.
    const grid = built.workbook.Sheets["CNR 2026 "];
    const header = grid[0].map((c) => (c === null ? "" : String(c).trim()));
    const pi = header.indexOf("Province");
    const body = grid.slice(spec.headerRows);
    return body.length === 13                                            // 9 Albay + 4 Masbate
        && body.filter((r) => r[pi] === "ALBAY").length === 9
        && body.filter((r) => r[pi] === "MASBATE").length === 4
        && header.includes("Date of Notification");                      // header block intact
  });

  await check("consolidation reports which areas are still missing", async () => {
    const entries = await store.getAllProvinceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries);
    return built.presentProvinces.length === 2 && built.missingProvinces.length === 5
        && built.missingProvinces.includes("NAGA CITY");
  });

  await check("POPULATION is NOT duplicated per province", async () => {
    const entries = await store.getAllProvinceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries);
    const pop = built.workbook.Sheets["POPULATION"];
    const fromFormat = template.parseUpload(formatBuffer, "Format.xlsx")["POPULATION"];
    // Two provinces uploaded, both carrying the region-wide POPULATION sheet - the consolidated
    // workbook must still hold exactly one copy, or every denominator would be doubled.
    return pop.length === fromFormat.length;
  });

  await check("POPULATION provenance is recorded in the notes", async () => {
    const entries = await store.getAllProvinceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries);
    return built.notes.some((n) => /POPULATION/.test(n) && /taken from/i.test(n));
  });

  await check("consolidated workbook reproduces the Format.xlsx sheet set", async () => {
    const entries = await store.getAllProvinceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries);
    const wanted = ["CNR 2026 ", "MN 2026", "TPT 2026", "TSR  COHORT", "TPT COHORT",
                    "POPULATION", "POPULATION CATCHMENT", "Facility List "];
    const missing = wanted.filter((n) => !built.workbook.SheetNames.includes(n));
    if (missing.length) throw new Error("missing from consolidated workbook: " + missing.join(", "));
    return true;
  });

  await check("consolidation refuses when no areas are uploaded", async () => {
    const saved = new Map(BLOB);
    for (const k of [...BLOB.keys()]) if (/^ntp-province\/[A-Z]/.test(k)) BLOB.delete(k);
    let threw = false;
    try { await consolidator.consolidate(); } catch (e) { threw = /nothing to consolidate/.test(e.message); }
    BLOB.clear(); for (const [k, v] of saved) BLOB.set(k, v);
    return threw;
  });

  await check("consolidation refuses without any POPULATION source", async () => {
    for (const p of ["ALBAY", "MASBATE"]) {
      const e = await store.getProvinceEntry(p);
      if (!e) continue;
      delete e.regionalSheets["POPULATION"];
      await store.saveProvinceEntry(p, e);
    }
    let threw = false;
    try { await consolidator.consolidate(); } catch (e) { threw = /POPULATION/.test(e.message); }
    return threw;
  });

  // ================================================================ delete + history
  await check("deleting an area removes only that slot", async () => {
    await store.deleteProvinceEntry("MASBATE");
    const all = await store.getAllProvinceEntries();
    return all["MASBATE"] === null && !!all["ALBAY"];
  });

  await check("history records who, what, when and outcome", async () => {
    await store.appendHistory({ action: "upload", target: "Albay", uploadedBy: "Dr Cruz",
      filename: "albay.xlsx", ok: true, message: "ok" });
    const h = await store.getHistory();
    return h[0].target === "Albay" && h[0].uploadedBy === "Dr Cruz" && !!h[0].at && h[0].ok === true;
  });

  await check("history keeps newest first and records failures", async () => {
    await store.appendHistory({ action: "upload-rejected", target: "Sorsogon", uploadedBy: "Admin",
      ok: false, message: "Missing required sheet" });
    const h = await store.getHistory();
    return h[0].target === "Sorsogon" && h[0].ok === false && h[1].target === "Albay";
  });

  // ================================================================ admin page
  await check("all 7 slots render server-side (visible without JavaScript)", () => {
    process.env.SESSION_SECRET = "test-secret";
    const M = require("module"); const orig = M._load;
    M._load = function (r) {
      if (r === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
      if (r === "../lib/kpiStore") return { getCurrentKpi: async () => ({ kpi: { meta: {} }, source: "seed", updatedAt: null }), blobConfigured: () => false };
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve(BASE + "api/admin.js")];
    const handler = require(BASE + "api/admin.js");
    let html = "";
    const res = { setHeader() {}, status() { return this; }, send(h) { html = h; }, json() {}, end() {} };
    return handler({ method: "GET", url: "/admin", headers: {} }, res).then(() => {
      M._load = orig;
      const block = html.slice(html.indexOf('id="provinceSlots"'), html.indexOf("Upload History"));
      const slots = (block.match(/data-slot="[^"]+"/g) || []);
      const btns = (block.match(/data-upload-for="[^"]+"/g) || []);
      const files = (block.match(/data-file-for="[^"]+"/g) || []);
      if (slots.length !== 7) throw new Error("expected 7 server-rendered slots, got " + slots.length);
      if (btns.length !== 7 || files.length !== 7) throw new Error("slot controls missing");
      for (const id of template.PROVINCE_SLOTS.map((x) => x.id)) {
        if (!block.includes('data-slot="' + id + '"')) throw new Error("missing slot: " + id);
      }
      return true;
    });
  });

  await check("admin page exposes 7 slots, history and template link", () => {
    const src = fs.readFileSync(BASE + "api/admin.js", "utf8");
    return src.includes('id="provinceSlots"') && src.includes('id="historyBox"')
        && src.includes("/api/province-data?template=1")
        && src.includes("Province &amp; City Data Uploads");
  });

  await check("admin page no longer offers a regional master or whole-region upload", () => {
    const src = fs.readFileSync(BASE + "api/admin.js", "utf8");
    return !src.includes("masterSlot") && !src.includes("Regional Master Reference File")
        && !src.includes("/api/upload") && !src.includes("Upload &amp; Recompute");
  });

  await check("admin client JS stays clear of template-literal syntax", () => {
    const src = fs.readFileSync(BASE + "api/admin.js", "utf8");
    const block = src.slice(src.lastIndexOf("Province upload slots"), src.lastIndexOf("</html>"));
    return !block.includes("`") && !block.includes("${");
  });

  report();
})();

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [name, ok, msg] of results) {
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (msg && !ok ? "  ->  " + msg : ""));
  }
  console.log("\n" + "=".repeat(62));
  console.log("TOTAL: " + pass + "/" + results.length + " passed");
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
