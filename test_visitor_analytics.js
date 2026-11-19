// Behavioral coverage for collection, concurrency, private reporting and the real admin DOM.
const assert = require("node:assert/strict");
const Module = require("module");
const { JSDOM } = require("jsdom");
process.env.SESSION_SECRET = "visitor-test-secret";
process.env.BLOB_STORE_ID = "visitor-test-store";
process.env.VERCEL_ENV = "production";

const blobs = new Map();
let failStorage = false, listCalls = 0, publicKpi = null;
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") return {
    async put(path, body, options) {
      assert.equal(options.access, "private");
      assert.equal(options.addRandomSuffix, false);
      assert(!blobs.has(path), "events must be immutable and collision-free");
      if (failStorage) throw new Error("storage offline");
      blobs.set(path, body);
    },
    async list({ prefix, cursor }) {
      listCalls++;
      if (failStorage) throw new Error("storage offline");
      // Force pagination at two entries, including simultaneous requests from the same browser.
      const paths = [...blobs.keys()].filter(p => p.startsWith(prefix)).sort();
      const start = Number(cursor || 0);
      return { blobs: paths.slice(start, start + 2).map(pathname => ({ pathname })),
        hasMore: paths.length > start + 2, cursor: paths.length > start + 2 ? String(start + 2) : undefined };
    },
  };
  if (request === "../lib/kpiStore") return {
    getCurrentKpi: async () => ({ kpi: publicKpi, source: "seed", updatedAt: null }),
    blobConfigured: () => !!process.env.BLOB_STORE_ID,
  };
  if (request === "../lib/provinceStore") return {
    getAllProvinceEntries: async () => ({}), getAllReferenceEntries: async () => ({}),
    blobConfigured: () => true,
  };
  return originalLoad.apply(this, arguments);
};
const auth = require("./lib/auth");
const store = require("./lib/visitorStore");
const traffic = require("./api/traffic");
const admin = require("./api/admin");
const index = require("./api/index");
function res() {
  return { code: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    end() { return this; }, writeHead(n, h) { this.code = n; Object.assign(this.headers, h); } };
}
function req(method = "POST", headers = {}) {
  return { method, headers: { host: "example.test", origin: "https://example.test",
    "content-type": "application/json", "user-agent": "Mozilla/5.0", ...headers } };
}
const cookie = () => `${auth.SESSION_COOKIE}=${auth.createSessionToken("master")}`;
(async () => {
  // Gate before any storage reads, even if an attacker knows the API URL.
  for (const value of [undefined, "invalid", "master.1.forged"]) {
    const r = res();
    await traffic(req("GET", { cookie: value }), r);
    assert.equal(r.code, 401); assert.deepEqual(r.body, { error: "Not authenticated." });
    assert.equal(r.headers["Cache-Control"], "private, no-store");
  }
  assert.equal(listCalls, 0);
  let r = res(); await admin(req("GET"), r); assert.equal(r.code, 303);
  assert.equal(r.headers.Location, "/login?next=/admin");
  for (const headers of [{ origin: "https://evil.test" }, { origin: undefined },
    { "content-type": "text/plain" }, { "sec-fetch-site": "cross-site" }]) {
    r = res(); await traffic(req("POST", headers), r); assert.equal(r.code, 403);
  }
  for (const headers of [{ dnt: "1" }, { "sec-gpc": "1" }, { cookie: cookie() }, { "user-agent": "Googlebot" }]) {
    r = res(); await traffic(req("POST", headers), r); assert.equal(r.code, 204);
    assert(!r.headers["Set-Cookie"]);
  }
  assert.equal(blobs.size, 0);
  r = res(); await traffic(req("PUT"), r); assert.equal(r.code, 405);
  assert.equal(r.headers.Allow, "GET, POST");

  r = res(); await traffic(req(), r); assert.equal(r.code, 204);
  const visitorCookie = r.headers["Set-Cookie"].split(";")[0];
  assert.match(visitorCookie, /^ntp_visitor=[a-f0-9]{64}$/);
  assert.match(r.headers["Set-Cookie"], /HttpOnly; SameSite=Lax; Max-Age=2592000/);
  await Promise.all(Array.from({ length: 12 }, async () => {
    const response = res(); await traffic(req("POST", { cookie: visitorCookie }), response);
    assert.equal(response.code, 204);
  }));
  let report = await store.getReport();
  assert.equal(report.views, 13); assert.equal(report.visitors, 1);
  assert.equal(report.daily[0].views, 13); assert.equal(report.daily.length, 30);
  assert(listCalls > 30, "pagination traversed all pages");
  r = res(); await traffic(req(), r);
  report = await store.getReport(); assert.equal(report.visitors, 2);

  // Philippine date rollover, cross-day deduplication, rolling window, environment separation.
  blobs.clear();
  const now = new Date("2026-11-19T16:00:00Z");
  assert.equal(store.phDay(now), "2026-11-20");
  await store.recordVisit("a", now);
  await store.recordVisit("a", new Date("2026-11-19T15:59:59Z"));
  await store.recordVisit("b", now);
  await store.recordVisit("old", new Date(now.getTime() - 30 * 86400000));
  process.env.VERCEL_ENV = "preview";
  await store.recordVisit("preview", now);
  process.env.VERCEL_ENV = "production";
  report = await store.getReport(now);
  assert.equal(report.views, 3); assert.equal(report.visitors, 2);
  assert.equal(report.daily[0].views, 2); assert.equal(report.daily[1].visitors, 1);
  assert.equal(report.from, "2026-10-22");
  assert([...blobs.values()].every(b => b === "{}"), "no personal information in event bodies");

  r = res(); await traffic(req("GET", { cookie: cookie() }), r);
  assert.equal(r.code, 200); assert(Array.isArray(r.body.daily));
  assert(!JSON.stringify(r.body).includes("ntp-traffic"));
  failStorage = true;
  r = res(); await traffic(req("GET", { cookie: cookie() }), r); assert.equal(r.code, 503);
  r = res(); await traffic(req(), r); assert.equal(r.code, 503);
  failStorage = false;
  delete process.env.BLOB_STORE_ID;
  await assert.rejects(store.getReport(), /not connected/);
  process.env.BLOB_STORE_ID = "visitor-test-store";

  // Real public handler: no report markup/counts, but successful empty dashboard gets tracking.
  r = res(); await index(req("GET"), r);
  assert.equal(r.code, 200); assert(r.body.includes("fetch('/api/traffic'"));
  assert(!r.body.includes('id="sec-visitors"')); assert(!r.body.includes("Unique visitors"));
  const tracked = store.withVisitorTracking("<body>Dashboard</body>");
  assert(tracked.includes("fetch('/api/traffic'"));
  assert(tracked.includes("navigator.globalPrivacyControl"));

  // Exercise the actual inline admin script, panel navigation, rendering and error recovery.
  r = res(); await admin(req("GET", { cookie: cookie() }), r); assert.equal(r.code, 200);
  const dom = new JSDOM(r.body, { url: "https://example.test/admin", runScripts: "outside-only" });
  const w = dom.window; let status = 200, calls = 0;
  w.fetch = async url => {
    if (url === "/api/traffic") {
      calls++;
      return { ok: status === 200, status, json: async () => status === 200 ? report : ({ error: "Storage unavailable" }) };
    }
    return { ok: true, json: async () => ({ slots: [], referenceSlots: [], history: [], users: [] }) };
  };
  for (const script of w.document.querySelectorAll("script")) w.eval(script.textContent);
  assert.equal(calls, 0, "no storage requests until admin loads report");
  w.document.querySelector('[data-target="sec-visitors"] a').click();
  assert.equal(w.document.getElementById("sec-visitors").style.display, "");
  assert.equal(w.document.getElementById("sec-uploads").style.display, "none");
  const button = w.document.getElementById("loadVisitorReport");
  const tick = () => new Promise(resolve => setTimeout(resolve, 15));
  button.click(); await tick();
  assert.equal(w.document.getElementById("visitorViews").textContent, "3");
  assert.equal(w.document.getElementById("visitorUnique").textContent, "2");
  assert.equal(w.document.getElementById("visitorToday").textContent, "2");
  assert.equal(w.document.querySelectorAll("#visitorDaily tr").length, 30);
  status = 503; button.click(); await tick();
  assert(w.document.getElementById("visitorReport").hidden);
  assert.match(w.document.getElementById("visitorReportStatus").textContent, /Storage unavailable/);
  assert.equal(button.disabled, false);
  status = 401; button.click(); await tick();
  assert.match(w.document.getElementById("visitorReportStatus").textContent, /session has expired/);
  dom.window.close();
  console.log("Visitor analytics: collection, concurrency, pagination, privacy, auth, dates, public/admin DOM and failures passed.");
})().catch(err => { console.error(err); process.exitCode = 1; });
