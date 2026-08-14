// Pre-deploy smoke test: loads every serverless handler the way Vercel does and invokes it,
// catching the class of problem that only shows up in production - a bad export shape, a require
// that fails at cold start, a route that 500s, or a missing environment variable.
const fs = require("fs");
const path = require("path");

const results = [];
const check = (n, ok, msg) => results.push([n, !!ok, ok ? "" : (msg || "")]);

const ROOT = __dirname;
const apiFiles = fs.readdirSync(path.join(ROOT, "api")).filter((f) => f.endsWith(".js"));

// ---------------------------------------------------------------- 1. cold-start / export shape
// Vercel requires each api/*.js to export a function (or {default}). A file that throws while
// loading, or exports the wrong thing, becomes a 500 on first request.
for (const f of apiFiles) {
  const p = path.join(ROOT, "api", f);
  let mod, err = null;
  try { mod = require(p); } catch (e) { err = e; }
  check(`api/${f} loads at cold start`, !err, err && err.message);
  if (err) continue;
  const handler = typeof mod === "function" ? mod : (mod && mod.default);
  check(`api/${f} exports a handler function`, typeof handler === "function",
    "exported " + (typeof mod));
}

// ---------------------------------------------------------------- 2. lib modules load
for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => x.endsWith(".js"))) {
  let err = null;
  try { require(path.join(ROOT, "lib", f)); } catch (e) { err = e; }
  check(`lib/${f} loads`, !err, err && err.message);
}

// ---------------------------------------------------------------- 3. vercel.json sanity
{
  let cfg = null, err = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")); }
  catch (e) { err = e; }
  check("vercel.json is valid JSON", !err, err && err.message);
  if (cfg) {
    const rewrites = cfg.rewrites || [];
    const dests = rewrites.map((r) => r.destination);
    check("vercel.json rewrites point at files that exist",
      dests.every((d) => {
        const rel = d.replace(/^\//, "") + ".js";
        return fs.existsSync(path.join(ROOT, rel));
      }),
      "missing: " + dests.filter((d) => !fs.existsSync(path.join(ROOT, d.replace(/^\//, "") + ".js"))).join(", "));
    // The new endpoints are file-routed (/api/<name>) and need no rewrite entry.
    check("province endpoints exist as routable files",
      fs.existsSync(path.join(ROOT, "api/province-upload.js")) &&
      fs.existsSync(path.join(ROOT, "api/province-data.js")));
  }
}

// ---------------------------------------------------------------- 4. build step works
{
  const gen = path.join(ROOT, "lib/assets.generated.js");
  check("assets.generated.js exists (build output committed)", fs.existsSync(gen));
  if (fs.existsSync(gen)) {
    let a = null, err = null;
    try { a = require(gen); } catch (e) { err = e; }
    check("assets.generated.js loads", !err, err && err.message);
    if (a) {
      check("bundle carries the dashboard template", typeof a.templatePart1 === "string" && a.templatePart1.length > 1000);
      check("bundle carries the dashboard JS", typeof a.dashboardJsFull === "string" && a.dashboardJsFull.length > 1000);
      check("bundle carries the KPI pipeline", typeof a.pipelineBrowserJs === "string" && a.pipelineBrowserJs.length > 1000);
      check("bundle is in sync with vendor/dashboard_js_full.txt",
        a.dashboardJsFull === fs.readFileSync(path.join(ROOT, "vendor/dashboard_js_full.txt"), "utf8"),
        "regenerate with: node scripts/generate-assets.js");
      check("bundle is in sync with vendor/dashboard_template_part1.txt",
        a.templatePart1 === fs.readFileSync(path.join(ROOT, "vendor/dashboard_template_part1.txt"), "utf8"),
        "regenerate with: node scripts/generate-assets.js");
    }
  }
}

// ---------------------------------------------------------------- 5. no bundled data remains
{
  check("no bundled KPI dataset ships with the app",
    !fs.existsSync(path.join(ROOT, "data/ntp_kpi_v4.json")));
  check("no data/ directory ships at all", !fs.existsSync(path.join(ROOT, "data")));
  check("legacy whole-region upload endpoint removed",
    !fs.existsSync(path.join(ROOT, "api/upload.js")));
  const kpiStoreSrc = fs.readFileSync(path.join(ROOT, "lib/kpiStore.js"), "utf8");
  check("kpiStore has no seed fallback", !/require\(["']\.\.\/data/.test(kpiStoreSrc));
  // Awardee Recognition itself stays; only its Activation Date gating was removed per instruction
  // ("only the activation date of Awardee Recognition must be removed not Awardee recognition itself").
  check("Awardee Recognition feature files are present",
    fs.existsSync(path.join(ROOT, "lib/awardsStore.js")) &&
    fs.existsSync(path.join(ROOT, "lib/awardRanking.js")) &&
    fs.existsSync(path.join(ROOT, "api/awards.js")));
  check("Activation Date feature has been fully removed",
    !fs.existsSync(path.join(ROOT, "lib/awardActivationStore.js")) &&
    !fs.existsSync(path.join(ROOT, "api/award-activation.js")));
  const consolidateSrc = fs.readFileSync(path.join(ROOT, "lib/consolidate.js"), "utf8");
  check("consolidation reads only province entries", !/getMaster/.test(consolidateSrc));
}

// ---------------------------------------------------------------- 6. the public page renders
// Two paths matter now: the awaiting-uploads page when nothing is stored, and the real dashboard
// once a consolidated dataset exists.
{
  const savedTok = process.env.BLOB_READ_WRITE_TOKEN, savedId = process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.BLOB_STORE_ID;
  for (const m of ["lib/kpiStore", "lib/provinceStore", "api/index.js"]) {
    const r = require.resolve(path.join(ROOT, m));
    delete require.cache[r];
  }
  const indexHandler = require(path.join(ROOT, "api/index.js"));
  let status = null, body = "";
  const res = { setHeader() {}, status(c) { status = c; return this; },
                send(b) { body = String(b); }, json() {}, end() {} };
  let err = null;
  try { require("util").types; } catch (e) { /* noop */ }
  return indexHandler({ method: "GET", url: "/", headers: {} }, res)
    .catch((e) => { err = e; })
    .then(() => {
      check("GET / responds when nothing is uploaded", !err && status === 200, err && err.message);
      check("empty state names the outstanding areas", /Awaiting provincial data/.test(body) && /<li>/.test(body));
      check("empty state shows no figures", !/rate_per_100k/.test(body));
      if (savedTok) process.env.BLOB_READ_WRITE_TOKEN = savedTok;
      if (savedId) process.env.BLOB_STORE_ID = savedId;

      // and the real dashboard still builds from a consolidated dataset
      let html = null, e2 = null;
      try {
        const { buildDashboardHtml } = require(path.join(ROOT, "lib/buildDashboardHtml"));
        html = buildDashboardHtml({ meta: {}, nodes: { REGION: {} } });
      } catch (e) { e2 = e; }
      check("dashboard HTML builds from a consolidated dataset", !e2, e2 && e2.message);
      if (html) {
        check("built page has no unreplaced data placeholder", !html.includes("__DATA_JSON__"));
        check("built page's sidebar module registry still lists the Awardee Recognition tab",
          html.includes('key:"awards"'));
        check("built page has no activation-gating 'Coming Soon' path reachable from renderAwards",
          !/isAwardsActiveForCurrentPage\(\)\)\{\s*el\.innerHTML\s*=\s*renderAwardsComingSoon/.test(html));
        check("built page includes the intro splash image", html.includes('id="introImage"'));
        check("built page has no leftover <video> element", !html.includes("<video"));
        check("built page script tags balance",
          (html.match(/<script/g) || []).length === (html.match(/<\/script>/g) || []).length);
        check("built page closes html", html.trim().endsWith("</html>"));
      }
      return continueChecks();
    });
}

function continueChecks() {
// ---------------------------------------------------------------- 7. auth behaves without a secret
// SESSION_SECRET is required at runtime. Verify the failure is a clean 401/500 rather than a crash,
// and that protected endpoints refuse anonymous callers.
{
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  delete require.cache[require.resolve(path.join(ROOT, "lib/auth"))];
  const auth = require(path.join(ROOT, "lib/auth"));

  // A well-formed cookie forces the code path that reads SESSION_SECRET. It must fail CLOSED -
  // returning false - not throw, because callers invoke isAuthenticated() before their try/catch
  // and an escaping throw becomes a bare 500 with no explanation.
  const wellFormed = (Date.now() + 3600000) + "." + "a".repeat(64);
  let threw = null, verdict = null;
  try { verdict = auth.isAuthenticated({ headers: { cookie: "ntp_admin_session=" + wellFormed } }); }
  catch (e) { threw = e; }
  check("missing SESSION_SECRET does not throw out of isAuthenticated()", !threw, threw && threw.message);
  check("missing SESSION_SECRET denies access (fails closed)", verdict === false, "returned " + verdict);

  // And login must say what is wrong instead of 500-ing anonymously.
  delete require.cache[require.resolve(path.join(ROOT, "api/login.js"))];
  const login = require(path.join(ROOT, "api/login.js"));
  let status = null, body = "";
  const res = { setHeader() {}, status(c) { status = c; return this; }, send(b) { body = String(b); },
                json(b) { body = JSON.stringify(b); }, end() {}, writeHead(c) { status = c; } };
  process.env.ADMIN_PASSWORD = "pw";
  try { login({ method: "POST", url: "/login", headers: {}, body: { password: "pw" } }, res); }
  catch (e) { body = "THREW: " + e.message; }
  check("login explains a missing SESSION_SECRET", status === 500 && /SESSION_SECRET/.test(body), body.slice(0, 90));
  delete process.env.ADMIN_PASSWORD;

  if (saved) process.env.SESSION_SECRET = saved; else process.env.SESSION_SECRET = "test-secret";
  delete require.cache[require.resolve(path.join(ROOT, "lib/auth"))];
  delete require.cache[require.resolve(path.join(ROOT, "api/login.js"))];
}

// ---------------------------------------------------------------- 8. protected endpoints reject anonymous
(async function () {
  process.env.SESSION_SECRET = "test-secret";
  const protectedEndpoints = ["province-upload", "province-data"];
  for (const name of protectedEndpoints) {
    const p = path.join(ROOT, "api", name + ".js");
    if (!fs.existsSync(p)) continue;
    delete require.cache[require.resolve(p)];
    const handler = require(p);
    let status = null, body = null;
    const res = {
      _h: {}, setHeader(k, v) { this._h[k] = v; },
      status(c) { status = c; return this; },
      json(b) { body = b; return this; },
      send(b) { body = b; return this; },
      end() {}, writeHead(c) { status = c; },
    };
    const req = { method: "GET", url: "/api/" + name, headers: {} };
    let err = null;
    try { await handler(req, res); } catch (e) { err = e; }
    check(`api/${name}.js rejects anonymous callers cleanly`,
      !err && (status === 401 || status === 405 || status === 303),
      err ? err.message : "status=" + status);
  }

  report();
})();
}

function report() {
  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, msg] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "   ->  " + msg));
  console.log("\n" + "=".repeat(64));
  console.log("TOTAL: " + pass + "/" + results.length + " passed");
  console.log(fail.length === 0 ? "\nDEPLOY READINESS: OK" : "\nDEPLOY READINESS: PROBLEMS FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
}
