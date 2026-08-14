// Region-wide reference uploads (Population, Facility List).
//
// Covers the three things that can actually go wrong:
//   1. validation - the right sheets are extracted, the wrong file is rejected with a useful message
//   2. precedence - an uploaded reference file beats the copies inside the provincial workbooks,
//      and removing it falls back to them (the behaviour the user chose)
//   3. the admin page - the two slots render side by side, and their buttons really fire
const XLSX = require("xlsx");
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

const BASE = __dirname + "/";
// Region.xlsx (a stale multi-province combined fixture) has been retired - Format.xlsx is now the
// standard. test_fixtures_CamNorte.xlsx is its real-data replacement: Camarines Norte's actual
// province-scope sheets (new long-format report sheets) plus the current region-wide POPULATION,
// POPULATION CATCHMENT and Facility List reference sheets. See test_fixtures_CamNorte.xlsx's build
// script note below for provenance.
const SRC = BASE + "test_fixtures_CamNorte.xlsx";

// ---------------------------------------------------------------- in-memory blob
const BLOB = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!BLOB.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => BLOB.get(p) }, blob: { uploadedAt: "" } };
      },
      async put(p, b) { BLOB.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { BLOB.delete(p); },
    };
  }
  // Only used by the direct-handler regression check below (section 3e) - harmless everywhere else,
  // since no other check in this file goes through an auth-gated HTTP handler.
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const template = require(BASE + "lib/provinceTemplate");
const store = require(BASE + "lib/provinceStore");
const consolidator = require(BASE + "lib/consolidate");
const { buildDashboardHtml } = require(BASE + "lib/buildDashboardHtml");

// api/reference-upload.js now consolidates via the standalone consolidation server (see
// lib/consolidationClient.js) instead of calling lib/consolidate.js in-process. Stub global.fetch to
// run the SAME consolidate()/saveKpi() in-process, against this file's own stubbed Blob store - this
// exercises the real HTTP request/response contract consolidationClient.js builds, without needing a
// real network call in tests.
process.env.CONSOLIDATION_SERVER_URL = "http://mock-consolidation-server.test";
process.env.CONSOLIDATION_SERVER_TOKEN = "test-consolidation-token";
const { saveKpi: __mockSaveKpi } = require(BASE + "lib/kpiStore");
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  try {
    const consolidation = await consolidator.consolidate(null, body.overrides || undefined);
    await __mockSaveKpi(consolidation.kpi);
    return {
      status: 200,
      json: async () => ({ ok: true, presentProvinces: consolidation.presentProvinces, missingProvinces: consolidation.missingProvinces }),
    };
  } catch (err) {
    return { status: 200, json: async () => ({ ok: false, code: err.code || null, error: err.message }) };
  }
};

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

/** Builds a one-sheet .xlsx buffer from an array-of-arrays. */
function bookOf(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

(async function run() {
  // ================================================================ 1. slot definitions
  const slots = template.REFERENCE_SLOTS;
  check("there are exactly two reference slots", slots.length === 2, "got " + slots.length);
  check("slot 1 is Population", slots[0] && slots[0].id === "POPULATION");
  check("slot 2 is Facility List", slots[1] && slots[1].id === "FACILITY_LIST");
  check("the Population slot owns both population sheets",
    slots[0] && slots[0].sheets.includes("POPULATION") && slots[0].sheets.includes("POPULATION CATCHMENT"),
    JSON.stringify(slots[0] && slots[0].sheets));
  check("the Facility List slot owns the trailing-space sheet name verbatim",
    slots[1] && slots[1].sheets[0] === "Facility List ",
    JSON.stringify(slots[1] && slots[1].sheets));
  check("reference slot ids do not collide with province slot ids",
    !slots.some((r) => template.PROVINCE_SLOTS.some((p) => p.id === r.id)));
  check("reference blobs are stored under their own prefix",
    store.referencePathname("POPULATION").startsWith("ntp-reference/") &&
    store.referencePathname("POPULATION") !== store.provincePathname("ALBAY"),
    store.referencePathname("POPULATION"));

  // ================================================================ 2. validation
  {
    const buf = bookOf({ POPULATION: [["Region", "Province", "Pop"], ["V", "ALBAY", 100]] });
    const parsed = template.parseUpload(buf, "pop.xlsx");
    const r = template.validateReferenceUpload(parsed, "POPULATION");
    check("a POPULATION workbook is accepted", r.ok, r.errors.join("; "));
    check("its grid is stored under the canonical sheet name", !!r.sheets["POPULATION"]);
    check("row count excludes the header rows", r.rowCounts["POPULATION"] === 2,
      "got " + r.rowCounts["POPULATION"]);   // POPULATION has headerRows 0
  }
  {
    // Uploading the wrong file to a slot must fail loudly, not store an empty entry.
    const buf = bookOf({ "CNR 2026 ": [["Province"], ["ALBAY"]] });
    const parsed = template.parseUpload(buf, "cnr.xlsx");
    const r = template.validateReferenceUpload(parsed, "POPULATION");
    check("a file with no Population sheet is rejected", !r.ok);
    check("the rejection names what was wanted and what was found",
      /Population/i.test(r.errors.join(" ")) && /CNR/i.test(r.errors.join(" ")),
      r.errors.join(" "));
  }
  {
    // The full Format.xlsx uploaded to one slot should yield that slot's sheets, not an error.
    if (fs.existsSync(SRC)) {
      const parsed = template.parseUpload(fs.readFileSync(SRC), "Format.xlsx");
      const rp = template.validateReferenceUpload(parsed, "POPULATION");
      const rf = template.validateReferenceUpload(parsed, "FACILITY_LIST");
      check("a full Format.xlsx works in the Population slot", rp.ok, rp.errors.join("; "));
      check("a full Format.xlsx works in the Facility List slot", rf.ok, rf.errors.join("; "));
      check("the Population slot ignores sheets belonging to other slots",
        !rp.sheets["Facility List "], Object.keys(rp.sheets).join(", "));
      check("the Facility List slot ignores the population sheets",
        !rf.sheets["POPULATION"], Object.keys(rf.sheets).join(", "));
    }
  }
  {
    const buf = bookOf({ POPULATION: [] });
    const parsed = template.parseUpload(buf, "empty.xlsx");
    const r = template.validateReferenceUpload(parsed, "POPULATION");
    check("an empty sheet is rejected rather than stored", !r.ok, JSON.stringify(r.rowCounts));
  }
  check("an unknown slot id is rejected",
    !template.validateReferenceUpload({}, "NOT_A_SLOT").ok);

  // ================================================================ 3. precedence
  if (!fs.existsSync(SRC)) {
    check("source workbook available for the precedence checks", false, "missing " + SRC);
    return report();
  }

  const parsedSrc = template.parseUpload(fs.readFileSync(SRC), "source.xlsx");
  const provinceIds = template.PROVINCE_SLOTS.map((s) => s.id);

  // One province file carrying everything, so the fallback path has something to fall back to.
  BLOB.clear();
  const res = template.validateProvinceUpload(parsedSrc, provinceIds[0]);
  check("province fixture validates", res.ok, res.errors.join("; "));
  await store.saveProvinceEntry(provinceIds[0], {
    provinceId: provinceIds[0], sheets: res.sheets, rowCounts: res.rowCounts,
    regionalSheets: res.regionalSheets,
    meta: { filename: "prov.xlsx", uploadedBy: "RefTest", uploadedAt: new Date().toISOString() },
  });
  check("the province file does carry a POPULATION copy to fall back to",
    !!(res.regionalSheets && res.regionalSheets["POPULATION"]));

  // --- (a) no reference upload -> falls back to the provincial copy ---
  {
    const entries = await store.getAllProvinceEntries();
    const refs = await store.getAllReferenceEntries();
    check("both reference slots start empty", !refs.POPULATION && !refs.FACILITY_LIST);
    const built = consolidator.buildConsolidatedWorkbook(entries, refs);
    const note = built.notes.find((n) => n.includes("POPULATION") || n.includes("Population"));
    check("with no reference upload, POPULATION comes from a province file",
      !!note && /file/.test(note) && !/upload/.test(note), note || "(no note)");
    check("the fallback source is recorded in the row counts",
      String(built.sheetRowCounts["POPULATION (source)"] || "").includes(provinceIds[0]),
      String(built.sheetRowCounts["POPULATION (source)"]));
  }

  // --- (b) a dedicated upload wins ---
  {
    // A deliberately distinctive grid, so "which copy won" is unambiguous.
    const marker = [["Region", "Province", "Population"], ["REGION V", "ALBAY", 12345]];
    const rp = template.validateReferenceUpload(
      template.parseUpload(bookOf({ POPULATION: marker }), "pop.xlsx"), "POPULATION");
    check("the marker population file validates", rp.ok, rp.errors.join("; "));
    await store.saveReferenceEntry("POPULATION", {
      slotId: "POPULATION", sheets: rp.sheets, rowCounts: rp.rowCounts,
      meta: { filename: "pop.xlsx", uploadedBy: "RefTest", uploadedAt: new Date().toISOString() },
    });

    const entries = await store.getAllProvinceEntries();
    const refs = await store.getAllReferenceEntries();
    const built = consolidator.buildConsolidatedWorkbook(entries, refs);

    const note = built.notes.find((n) => n.indexOf("POPULATION") === 1 || /"POPULATION"/.test(n));
    check("the note says POPULATION now comes from the Population upload",
      !!note && /Population upload/.test(note), note || "(no note)");

    // buildConsolidatedWorkbook's Sheets values are plain array-of-arrays grids, not real SheetJS
    // Sheet objects (see lib/consolidate.js's gridToSheet) - read directly rather than round-tripping.
    const grid = built.workbook.Sheets["POPULATION"];
    const flat = JSON.stringify(grid);
    check("the consolidated POPULATION sheet is the uploaded one, not the provincial copy",
      flat.includes("12345") && grid.length === 2, "rows: " + grid.length);

    // The provincial copy of the OTHER sheet must be untouched by this.
    check("Facility List still falls back to the province file",
      String(built.sheetRowCounts["Facility List  (source)"] ||
             built.sheetRowCounts["Facility List (source)"] || "").includes(provinceIds[0]) ||
      built.notes.some((n) => /Facility List/.test(n) && /file/.test(n)),
      built.notes.filter((n) => /Facility/.test(n)).join(" | "));
  }

  // --- (c) deleting the reference upload restores the fallback ---
  {
    await store.deleteReferenceEntry("POPULATION");
    const entries = await store.getAllProvinceEntries();
    const refs = await store.getAllReferenceEntries();
    check("the slot is empty again after delete", !refs.POPULATION);
    const built = consolidator.buildConsolidatedWorkbook(entries, refs);
    // buildConsolidatedWorkbook's Sheets values are plain array-of-arrays grids, not real SheetJS
    // Sheet objects (see lib/consolidate.js's gridToSheet) - read directly rather than round-tripping.
    const grid = built.workbook.Sheets["POPULATION"];
    check("POPULATION falls back to the provincial copy after delete",
      grid.length > 2 && !JSON.stringify(grid).includes("12345"), "rows: " + grid.length);
  }

  // --- (d) slot isolation: writing one reference slot leaves the other and the provinces alone ---
  {
    const rf = template.validateReferenceUpload(
      template.parseUpload(bookOf({ "Facility List ": [["Facility", "Province"], ["X RHU", "ALBAY"]] }),
        "fac.xlsx"), "FACILITY_LIST");
    await store.saveReferenceEntry("FACILITY_LIST", {
      slotId: "FACILITY_LIST", sheets: rf.sheets, rowCounts: rf.rowCounts,
      meta: { filename: "fac.xlsx", uploadedBy: "RefTest", uploadedAt: new Date().toISOString() },
    });
    const refs = await store.getAllReferenceEntries();
    check("writing Facility List did not populate the Population slot", !refs.POPULATION);
    check("Facility List slot holds its own file", !!refs.FACILITY_LIST);
    const prov = await store.getProvinceEntry(provinceIds[0]);
    check("writing a reference slot left the province dataset intact",
      !!prov && Object.keys(prov.sheets || {}).length > 0);
  }

  // --- (e) the live site must be visible even with zero province files, as long as Population is
  //         uploaded: a Population-only reference upload must itself succeed (previously this failed
  //         outright, since consolidate() checked "any province uploaded" before "is there a
  //         population source", so a legitimately valid reference-only upload was rejected with a
  //         confusing "nothing to consolidate" error) and must publish a full, honest, all-zero shell
  //         - every real province/municipality node present, real population, zero fabricated cases.
  {
    BLOB.clear();
    const popParsed = template.parseUpload(fs.readFileSync(SRC), "source.xlsx");
    const rp = template.validateReferenceUpload(popParsed, "POPULATION");
    check("the real Population sheet validates on its own", rp.ok, rp.errors.join("; "));
    await store.saveReferenceEntry("POPULATION", {
      slotId: "POPULATION", sheets: rp.sheets, rowCounts: rp.rowCounts,
      meta: { filename: "population.xlsx", uploadedBy: "RefTest", uploadedAt: new Date().toISOString() },
    });

    const entries = await store.getAllProvinceEntries();
    check("zero province files are present for this check", Object.keys(entries).every((k) => !entries[k]),
      JSON.stringify(Object.keys(entries).filter((k) => entries[k])));

    let consolidation = null, threw = null;
    try { consolidation = await consolidator.consolidate(); } catch (e) { threw = e; }
    check("consolidation SUCCEEDS with zero province files, as long as Population is uploaded",
      !threw && !!consolidation, threw && threw.message);

    if (consolidation) {
      const kpi = consolidation.kpi;
      check("the shell KPI has a REGION node", !!(kpi.nodes && kpi.nodes.REGION));
      check("the shell KPI carries the real regional population, not zero/fabricated",
        !!(kpi.nodes && kpi.nodes.REGION && kpi.nodes.REGION.population > 0),
        kpi.nodes && kpi.nodes.REGION && kpi.nodes.REGION.population);
      check("every province node is present in the shell (full geography renders)",
        provinceIds.every((id) => !!(kpi.nodes && kpi.nodes["P|" + id])),
        Object.keys(kpi.nodes || {}).filter((k) => k.startsWith("P|")).join(", "));
      check("case counts are honestly zero, not fabricated",
        kpi.nodes.REGION.cnr && kpi.nodes.REGION.cnr.notified === 0,
        kpi.nodes.REGION.cnr && kpi.nodes.REGION.cnr.notified);

      // Publishing this via saveKpi() is exactly what api/index.js's GET / then renders instead of
      // the "Awaiting provincial data" page - prove buildDashboardHtml accepts this shape cleanly.
      let html = null, buildThrew = null;
      try { html = buildDashboardHtml(kpi, {}); } catch (e) { buildThrew = e; }
      check("buildDashboardHtml renders the shell KPI without throwing", !buildThrew && !!html,
        buildThrew && buildThrew.message);
      check("the rendered page embeds the real population, not the awaiting-uploads page",
        !!html && html.includes(String(kpi.nodes.REGION.population)) && !/Awaiting provincial data/.test(html),
        html ? "len=" + html.length : "(no html)");
    }
  }

  // --- (f) THE REPORTED BUG, reproduced at the actual HTTP handler: uploading Facility List (or any
  //         reference file) while NEITHER Population nor any province case file exists anywhere must
  //         NOT be rejected/rolled back. Previously api/reference-upload.js treated "consolidate()
  //         can't publish yet" as a hard failure and DELETED the just-saved entry, so the admin saw
  //         "File was valid, but consolidation failed so nothing was published: No province files
  //         have been uploaded yet - nothing to consolidate." and the Facility List file was gone -
  //         even though it was completely valid and only needed Population to arrive later.
  {
    BLOB.clear();
    const referenceUpload = require(BASE + "api/reference-upload.js");
    const buf = bookOf({ "Facility List ": [["Facility", "Municipality", "Province"],
      ["TEST RHU", "TEST CITY", "ALBAY"]] });
    function mockReq(body) {
      return { method: "POST", headers: {}, url: "/api/reference-upload?slot=FACILITY_LIST&filename=fac.xlsx&uploadedBy=Tester",
        on(event, cb) { if (event === "data" && body) cb(body); if (event === "end") cb(); return this; } };
    }
    function mockRes() {
      return { _status: 200, _body: null, status(c) { this._status = c; return this; },
        json(o) { this._body = o; return this; }, send(o) { this._body = o; return this; }, setHeader() {} };
    }
    const res = mockRes();
    await referenceUpload(mockReq(buf), res);

    check("Facility-List-only upload (no Population, no provinces) responds 200, not rejected",
      res._status === 200, "status=" + res._status + " body=" + JSON.stringify(res._body));
    check("the response says it was saved but not yet published, not an error",
      res._body && res._body.ok === true && res._body.notPublished === true,
      JSON.stringify(res._body));
    check("the misleading 'nothing was published' error text does not appear",
      !res._body || !res._body.error, JSON.stringify(res._body));

    const stored = await store.getReferenceEntry("FACILITY_LIST");
    check("the Facility List file is actually still stored, not rolled back/deleted",
      !!stored && !!stored.sheets && !!stored.sheets["Facility List "],
      stored ? "present but missing sheet" : "(entry is gone - the bug)");
    // No assertion needed on the published KPI here - the point is that the FILE survives; publishing
    // still correctly waits for Population to exist somewhere, already proven by section (e) above.
  }

  await adminUiChecks();
  report();
})().catch((e) => { console.error("ERROR:", e && e.stack); process.exit(1); });

// ================================================================ 4. admin page
async function adminUiChecks() {
  let JSDOM;
  try { ({ JSDOM } = require("/tmp/node_modules/jsdom")); }
  catch (e) { check("jsdom available for the admin page checks", false, e.message); return; }

  const stubbed = Module._load;
  Module._load = function (r) {
    if (r === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
    if (r === "../lib/kpiStore") {
      return { getCurrentKpi: async () => ({ kpi: { meta: {} }, source: "seed", updatedAt: null }),
               blobConfigured: () => true };
    }
    return stubbed.apply(this, arguments);
  };
  const adminHandler = require(BASE + "api/admin.js");
  Module._load = stubbed;

  let html = "";
  await adminHandler({ method: "GET", url: "/admin", headers: {} },
    { setHeader() {}, status() { return this; }, send(h) { html = h; }, json() {}, end() {} });

  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.test/admin" });
  const { window } = dom;
  const calls = [];
  window.confirm = () => true;
  window.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
    const u = String(url);
    if (u.startsWith("/api/province-data")) {
      return { ok: true, status: 200, json: async () => ({
        blobConfigured: true,
        slots: template.PROVINCE_SLOTS.map((s) => ({ id: s.id, label: s.label, uploaded: false,
          status: "No file uploaded", rowCounts: null, totalRows: 0, warnings: [] })),
        referenceSlots: template.REFERENCE_SLOTS.map((s) => ({ id: s.id, label: s.label, hint: s.hint,
          sheets: s.sheets, uploaded: false, status: "No file uploaded", rowCounts: null,
          totalRows: 0, warnings: [] })),
        history: [],
      }) };
    }
    if (u.startsWith("/api/reference-upload")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, target: "Population",
        rowCounts: { POPULATION: 5 }, warnings: [], presentProvinces: ["ALBAY"], missingProvinces: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // The bug this catches: an escaped quote inside the client script is consumed by the server-side
  // template literal and reaches the browser as a bare quote, breaking every button on the page.
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let scriptError = null;
  for (const src of scripts) { try { window.eval(src); } catch (e) { scriptError = e; } }
  check("admin page script still runs without error", !scriptError, scriptError && scriptError.message);

  const doc = window.document;
  check("both reference slots are server-rendered (visible without JS)",
    doc.querySelectorAll("#referenceSlots [data-ref-upload-for]").length === 2,
    "got " + doc.querySelectorAll("#referenceSlots [data-ref-upload-for]").length);
  check("each reference slot has its own file input",
    doc.querySelectorAll("#referenceSlots [data-ref-file-for]").length === 2);
  check("the Population slot is present by id", !!doc.querySelector('[data-ref-upload-for="POPULATION"]'));
  check("the Facility List slot is present by id", !!doc.querySelector('[data-ref-upload-for="FACILITY_LIST"]'));

  // Side by side is the actual request: a 2-column grid on the container.
  const grid = doc.getElementById("referenceSlots");
  check("the two slots sit in a side-by-side grid container",
    grid && grid.className.includes("ref-grid"), grid && grid.className);
  check("the grid is defined as two columns",
    /\.ref-grid\{[^}]*grid-template-columns:1fr 1fr/.test(html));
  check("the grid collapses to one column on narrow screens",
    /@media \(max-width:640px\)\{ \.ref-grid\{grid-template-columns:1fr;\} \}/.test(html));

  check("province slots are untouched (still 7)",
    doc.querySelectorAll("#provinceSlots [data-upload-for]").length === 7,
    "got " + doc.querySelectorAll("#provinceSlots [data-upload-for]").length);

  await new Promise((r) => setTimeout(r, 40));

  // click Upload on the Population slot
  const input = doc.querySelector('#referenceSlots [data-ref-file-for="POPULATION"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ name: "pop.xlsx", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }],
  });
  doc.querySelector('#referenceSlots [data-ref-upload-for="POPULATION"]')
     .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  const call = calls.find((c) => c.url.includes("/api/reference-upload"));
  check("clicking Upload fires a POST to /api/reference-upload", !!call,
    "calls: " + calls.map((c) => c.url).join(" | "));
  if (call) {
    check("the request names the slot", call.url.includes("slot=POPULATION"), call.url);
    check("the request carries the filename", call.url.includes("filename=pop.xlsx"), call.url);
    check("the request carries uploadedBy from the signed-in session, not a typed name",
      call.url.includes("uploadedBy=master"), call.url);
    check("the request sends the file bytes", !!call.body);
    check("the request uses POST", call.method === "POST", call.method);
  }
  const banner = doc.getElementById("statusBanner");
  check("the result is reported to the user", /region-wide|rebuilt/i.test(banner.textContent),
    banner.textContent);
}

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nREFERENCE UPLOADS WORKING" : "\nREFERENCE UPLOAD ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
