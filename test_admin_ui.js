// Drives the real /admin page in a DOM: renders it, runs its client script, and clicks the
// per-province Upload buttons to prove the whole browser-side path actually fires.
const { JSDOM } = require("/tmp/node_modules/jsdom");
const Module = require("module");

process.env.SESSION_SECRET = "test-secret";

const BASE = __dirname + "/";
const { PROVINCE_SLOTS } = require(BASE + "lib/provinceTemplate");

// stub the admin handler's server deps
const origLoad = Module._load;
Module._load = function (r) {
  if (r === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  if (r === "../lib/kpiStore") {
    return { getCurrentKpi: async () => ({ kpi: { meta: {} }, source: "seed", updatedAt: null }),
             blobConfigured: () => true };
  }
  return origLoad.apply(this, arguments);
};
const adminHandler = require(BASE + "api/admin.js");

const results = [];
const check = (n, ok, msg) => results.push([n, !!ok, ok ? "" : (msg || "")]);

function getHtml() {
  let html = "";
  const res = { setHeader() {}, status() { return this; }, send(h) { html = h; }, json() {}, end() {} };
  return adminHandler({ method: "GET", url: "/admin", headers: {} }, res).then(() => html);
}

/**
 * Boots the page in jsdom with a controllable fetch, runs its inline script, and returns handles.
 * @param {object} opts { statusOk: whether /api/province-data succeeds, uploadOk, uploadError }
 */
async function boot(opts) {
  const o = opts || {};
  const html = await getHtml();
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.test/admin" });
  const { window } = dom;
  const calls = [];
  window.confirm = () => true;
  window.alert = () => {};

  // Captures every window.open() the admin page makes, and every later assignment to
  // .location on the tab it returned. Used below to assert that NO popup/tab is ever opened by an
  // upload - the admin page must stay on this exact page and only update the inline banner.
  const opens = [];
  window.open = function (url, target) {
    const tab = {
      closed: false, _locations: [],
      document: { write(s) { tab._written = s; }, close() {} },
      focus() {}, print() {}, close() { tab.closed = true; },
      get location() { return tab._locations[tab._locations.length - 1]; },
      set location(v) { tab._locations.push(v); },
    };
    opens.push({ url: url === undefined ? "" : String(url), target, tab });
    return tab;
  };

  window.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
    const u = String(url);
    if (u.startsWith("/api/province-data") && (!init || !init.method || init.method === "GET")) {
      if (o.statusOk === false) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      return {
        ok: true, status: 200,
        json: async () => ({
          blobConfigured: true,
          slots: PROVINCE_SLOTS.map((s) => ({ id: s.id, label: s.label, uploaded: false,
            status: "No file uploaded", filename: null, uploadedBy: null, uploadedAt: null,
            rowCounts: null, totalRows: 0, warnings: [] })),
          history: [],
        }),
      };
    }
    if (u.startsWith("/api/province-upload")) {
      if (o.uploadOk === false) {
        return { ok: false, status: 400, json: async () => ({ error: o.uploadError || "rejected" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, target: "Albay",
        rowCounts: { "CNR 2026 ": 3 }, warnings: [], presentProvinces: ["ALBAY"],
        missingProvinces: ["MASBATE"] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // run every inline <script> in the page
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let scriptError = null;
  for (const src of scripts) {
    try { window.eval(src); } catch (e) { scriptError = e; }
  }
  return { window, calls, opens, scriptError, html };
}

/** Attaches a fake file to an <input type=file> so the click handler sees one. */
function attachFile(window, input, name) {
  const file = {
    name: name,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  // ---------------------------------------------------------------- page boots
  {
    const { window, scriptError } = await boot({});
    check("admin page script runs without error", !scriptError, scriptError && scriptError.message);
    const btns = window.document.querySelectorAll("#provinceSlots [data-upload-for]");
    check("7 upload buttons exist in the DOM", btns.length === 7, "got " + btns.length);
    check("7 file inputs exist in the DOM",
      window.document.querySelectorAll("#provinceSlots [data-file-for]").length === 7);
  }

  // ---------------------------------------------------------------- happy path
  {
    const { window, calls, opens } = await boot({});
    await sleep(30);   // let loadProvincePanel() settle and re-wire
    const doc = window.document;
    const input = doc.querySelector('#provinceSlots [data-file-for="ALBAY"]');
    attachFile(window, input, "albay.xlsx");
    const btn = doc.querySelector('#provinceSlots [data-upload-for="ALBAY"]');
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(60);

    const uploadCall = calls.find((c) => c.url.includes("/api/province-upload"));
    check("clicking Upload fires a POST to /api/province-upload", !!uploadCall,
      "calls seen: " + calls.map((c) => c.url).join(" | "));
    if (uploadCall) {
      check("upload URL carries the province", uploadCall.url.includes("province=ALBAY"), uploadCall.url);
      check("upload URL carries the filename", uploadCall.url.includes("filename=albay.xlsx"), uploadCall.url);
      check("upload URL carries uploadedBy from the signed-in session, not a typed name",
        uploadCall.url.includes("uploadedBy=master"), uploadCall.url);
      check("upload sends the file bytes as the body", !!uploadCall.body);
      check("upload uses POST", uploadCall.method === "POST", uploadCall.method);
    }
    const banner = window.document.getElementById("statusBanner");
    check("success is reported to the user", /upload successful|updated|rebuilt/i.test(banner.textContent), banner.textContent);
    check("success banner is styled green (ok)", banner.className.includes("ok"), banner.className);

    // The admin must stay on this exact page throughout: no popup, no redirect, no new tab. Only
    // the inline banner above updates. Previously a "preview tab" was opened via window.open() and
    // navigated to the live dashboard - that behaviour was deliberately removed so the admin never
    // loses their place on the page.
    check("no popup/tab is opened for the upload", opens.length === 0,
      "window.open() was called " + opens.length + " time(s)");
  }

  // ---------------------------------------------------------------- guard rails
  {
    const { window, calls } = await boot({});
    await sleep(30);
    const doc = window.document;
    // no file chosen
    doc.querySelector('#provinceSlots [data-upload-for="MASBATE"]')
       .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(40);
    check("upload is blocked when no file is chosen",
      !calls.some((c) => c.url.includes("/api/province-upload")));
    check("missing file is explained", /choose a file/i.test(doc.getElementById("statusBanner").textContent));
  }

  // ---------------------------------------------------------------- server rejects
  {
    const { window, opens } = await boot({ uploadOk: false, uploadError: "Missing required sheet \"CNR 2026\"." });
    await sleep(30);
    const doc = window.document;
    attachFile(window, doc.querySelector('#provinceSlots [data-file-for="SORSOGON"]'), "bad.xlsx");
    doc.querySelector('#provinceSlots [data-upload-for="SORSOGON"]')
       .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    // A rejected upload must never open any popup/tab - it stays entirely on this page, same as a
    // success. The dashboard itself is untouched: the server rejects an invalid file before storing
    // it, so nothing published changes just because this attempt failed.
    check("a rejected upload does not open any popup/tab", opens.length === 0,
      "window.open() was called " + opens.length + " time(s)");
    const banner = doc.getElementById("statusBanner");
    check("server-side rejection reaches the user verbatim",
      /Missing required sheet/.test(banner.textContent), banner.textContent);
    check("failure banner is styled red (err)", banner.className.includes("err"), banner.className);
    check("failure message is prefixed 'Upload failed'", /^Upload failed/.test(banner.textContent), banner.textContent);
    const btn = doc.querySelector('#provinceSlots [data-upload-for="SORSOGON"]');
    check("button is re-enabled after a failure", btn.disabled === false);
  }

  // ---------------------------------------------------------------- status endpoint down
  {
    const { window, calls } = await boot({ statusOk: false });
    await sleep(40);
    const doc = window.document;
    const btns = doc.querySelectorAll("#provinceSlots [data-upload-for]");
    check("slots survive when /api/province-data fails", btns.length === 7, "got " + btns.length);
    attachFile(window, doc.querySelector('#provinceSlots [data-file-for="ALBAY"]'), "albay.xlsx");
    doc.querySelector('#provinceSlots [data-upload-for="ALBAY"]')
       .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(60);
    check("upload still works when the status call failed",
      calls.some((c) => c.url.includes("/api/province-upload")),
      "calls: " + calls.map((c) => c.url).join(" | "));
  }

  // ---------------------------------------------------------------- single data source
  // The regional master slot and the legacy whole-region upload are both gone: provincial files
  // are the only way data enters the system.
  {
    const { window } = await boot({});
    await sleep(30);
    const doc = window.document;
    check("no regional master upload control remains",
      !doc.getElementById("masterFile") && !doc.getElementById("masterUploadBtn"));
    check("no legacy whole-region upload control remains",
      !doc.getElementById("fileInput") && !doc.getElementById("uploadBtn"));
    // Every file input on the page must belong to a known slot - 7 provincial areas plus the two
    // region-wide reference slots. The point of this check is that no UNACCOUNTED-FOR upload control
    // creeps back in, so it is written as "all inputs are inside a known container" rather than a
    // bare count, which would have to be bumped every time a legitimate slot is added.
    const allFileInputs = Array.from(doc.querySelectorAll('input[type="file"]'));
    const inProvince = allFileInputs.filter((i) => i.closest("#provinceSlots"));
    const inReference = allFileInputs.filter((i) => i.closest("#referenceSlots"));
    check("all 7 province slots have a file input", inProvince.length === 7, "found " + inProvince.length);
    check("both region-wide reference slots have a file input", inReference.length === 2,
      "found " + inReference.length);
    // Card order is a deliberate layout choice: the things you act on come first, the audit log and
    // account management last. Team Accounts is the newest card and sits last on the page.
    const headings = Array.from(doc.querySelectorAll(".card h2")).map((h) => h.textContent.trim());
    check("Team Accounts is the last card on the page",
      headings[headings.length - 1] === "Team Accounts", headings.join(" > "));
    check("Upload History comes right before Team Accounts",
      headings[headings.length - 2] === "Upload History", headings.join(" > "));
    check("the action cards still come before Upload History and Team Accounts",
      headings.indexOf("Province & City Data Uploads") < headings.indexOf("Upload History") &&
      headings.indexOf("Regional Reference Data") < headings.indexOf("Upload History") &&
      headings.indexOf("Awardee Recognition") < headings.indexOf("Upload History"),
      headings.join(" > "));
    check("the Awardee Recognition admin panel is present (override picker only, no activation dates)",
      headings.includes("Awardee Recognition"), headings.join(" > "));
    check("the Activation Dates panel has been removed",
      !doc.getElementById("activationDatesBox") && !doc.getElementById("saveActivationBtn"),
      "activationDatesBox=" + !!doc.getElementById("activationDatesBox"));
    check("the history container survived the move", !!doc.getElementById("historyBox"));

    check("there are no upload controls outside the known slots",
      inProvince.length + inReference.length === allFileInputs.length,
      "total " + allFileInputs.length + " vs " + (inProvince.length + inReference.length) + " accounted for");
  }

  report();
})();

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, msg] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "   ->  " + msg));
  console.log("\n" + "=".repeat(62));
  console.log("TOTAL: " + pass + "/" + results.length + " passed");
  console.log(fail.length === 0 ? "\nADMIN UI WORKS" : "\nSOME CHECKS FAILED");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
