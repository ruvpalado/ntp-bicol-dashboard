// Focused functional check of the reconstructed api/awards.js + lib/awardsStore.js +
// lib/awardRanking.js (rebuilt from scratch after an earlier over-broad deletion, per user
// clarification: "only the activation date of Awardee Recognition must be remove not Awardee
// recognition itself"). No original source was available to restore verbatim, so this proves the
// rebuilt version actually behaves correctly end-to-end - not just that it loads.
const Module = require("module");

process.env.SESSION_SECRET = "test-secret";
process.env.BLOB_READ_WRITE_TOKEN = "test-token";

const STORE = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!STORE.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => STORE.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) { STORE.set(p, String(b)); return { url: "memory://" + p }; },
      async del(p) { STORE.delete(p); return true; },
    };
  }
  return origLoad.apply(this, arguments);
};
global.Response = class { constructor(s) { this._s = s; } async text() { return this._s.text(); } };

const BASE = __dirname + "/";
const awardsHandler = require(BASE + "api/awards.js");
const { getCurrentKpi } = require(BASE + "lib/kpiStore");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

function mockReq(method, url, jsonBody) {
  const body = jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : null;
  return { method, url, headers: {}, on(e, cb) { if (e === "data" && body) cb(body); if (e === "end") cb(); return this; } };
}
function mockRes() {
  return { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; }, send(o) { this._body = o; return this; }, setHeader() {} };
}

(async function run() {
  // Seed a fake published KPI with two provinces so candidate ranking has real data to rank.
  const fakeKpi = {
    meta: { operational_provinces: ["ALBAY", "MASBATE"] },
    nodes: {
      "P|ALBAY": { cnr: { rate_per_100k: 120, notified: 500 }, targets: { ctbn: 900 }, tsr: { dstb: { rate: 88 }, drtb: { rate: 70 } }, tpt: { coverage_pct: 55 } },
      "P|MASBATE": { cnr: { rate_per_100k: 200, notified: 800 }, targets: { ctbn: 1000 }, tsr: { dstb: { rate: 91 }, drtb: { rate: 60 } }, tpt: { coverage_pct: 40 } },
      "M|ALBAY|LEGAZPI": { cnr: { rate_per_100k: 150, notified: 120 }, targets: { ctbn: 200 } },
      "M|ALBAY|TABACO": { cnr: { rate_per_100k: 90, notified: 60 }, targets: { ctbn: 100 } },
      "M|MASBATE|MASBATE CITY": { cnr: { rate_per_100k: 300, notified: 150 }, targets: { ctbn: 150 } },
      "F|ALBAY|LEGAZPI|Fac A": { tsr: { dstb: { rate: 90, by_bact_status: { "BACTERIOLOGICALLY CONFIRMED": 5 } }, cure_dstb: { rate: 80 }, drtb: { rate: 70 }, mn: { rate: 70 } }, tpt: { coverage_pct: 55 } },
      "F|ALBAY|TABACO|Fac B": { tsr: { dstb: { rate: 90, by_bact_status: { "BACTERIOLOGICALLY CONFIRMED": 9 } }, cure_dstb: { rate: 80 }, drtb: { rate: 60 }, mn: { rate: 70 } }, tpt: { coverage_pct: 40 } },
      "F|MASBATE|MASBATE CITY|Fac C": { tsr: { dstb: { rate: 92, by_bact_status: { "BACTERIOLOGICALLY CONFIRMED": 3 } }, cure_dstb: { rate: 88 }, drtb: { rate: 60 }, mn: { rate: 70 } }, tpt: { coverage_pct: 40 } },
    },
  };
  // Give ALBAY 16 more municipalities so the candidates API's "return ALL units for the selection"
  // contract (no top-15 cap - the admin awardee standings table shows every municipality/facility)
  // is actually exercised: ALBAY then has 18 municipalities total.
  for (let i = 1; i <= 16; i++) {
    fakeKpi.nodes["M|ALBAY|MUNICIPALITY " + i] = { cnr: { rate_per_100k: 10 + i, notified: i * 5 }, targets: { ctbn: i * 10 } };
  }
  const { saveKpi } = require(BASE + "lib/kpiStore");
  await saveKpi(fakeKpi);
  const roundTrip = await getCurrentKpi();
  check("seeded KPI round-trips through kpiStore for the test setup", !!roundTrip.kpi, JSON.stringify(roundTrip));

  // 1. GET is public (no auth needed) and returns the empty-state shape before anything is assigned.
  {
    const req = mockReq("GET", "/api/awards");
    const res = mockRes();
    await awardsHandler(req, res);
    check("GET /api/awards succeeds without auth", res._status === 200, JSON.stringify(res._body));
    check("empty awards state is {} before anything is assigned", res._body && JSON.stringify(res._body.awards) === "{}", JSON.stringify(res._body));
  }

  // 2. Region-scope candidates rank PROVINCES against each other by their own aggregated
  //    accomplishments - highest metric first - MASBATE (CNR 200) before ALBAY (CNR 120).
  {
    const req = mockReq("GET", "/api/awards?candidates=1&category=cnr&scope=region");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("region CNR candidates rank provinces (MASBATE then ALBAY)",
      c && c[0] && c[0].key === "P|MASBATE"
        && c[0].name === "Masbate"
        && c[1] && c[1].key === "P|ALBAY" && c[1].name === "Albay", JSON.stringify(c));
  }

  // 3. Province-scope CNR candidates rank municipalities within ALBAY (municipality is CNR's provinceUnit).
  {
    const req = mockReq("GET", "/api/awards?candidates=1&category=cnr&scope=province&province=ALBAY");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("province CNR candidates rank municipalities (LEGAZPI 150 before TABACO 90)",
      c && c[0] && /LEGAZPI/i.test(c[0].name) && c[1] && /TABACO/i.test(c[1].name), JSON.stringify(c));
    check("province CNR candidates return ALL 18 municipalities - no top-15 truncation",
      c && c.length === 18, JSON.stringify(c && c.length));
  }

  // 3b. CNR candidates carry Case Notified and Case to be Notified alongside the rate.
  {
    const req = mockReq("GET", "/api/awards?candidates=1&category=cnr&scope=region");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("region CNR candidates carry cnrNotified and cnrTarget (MASBATE: 800/1000; ALBAY: 500/900)",
      c && c[0] && c[0].key === "P|MASBATE" && c[0].cnrNotified === 800 && c[0].cnrTarget === 1000
        && c[1] && c[1].key === "P|ALBAY" && c[1].cnrNotified === 500 && c[1].cnrTarget === 900,
      JSON.stringify(c));
  }

  // 4. DSTB Treatment Success ranks facilities at the PROVINCIAL level (provinceUnit facility), and
  //    PROVINCES at the REGIONAL level. Region ranks provinces by their own aggregated TSR (MASBATE
  //    dstb.rate 91 before ALBAY 88).
  {
    const req = mockReq("GET", "/api/awards?candidates=1&category=dstb_tsr&scope=region");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("region DSTB candidates rank provinces by their aggregated treatment success (MASBATE then ALBAY)",
      c && c[0] && c[0].key === "P|MASBATE" && c[1] && c[1].key === "P|ALBAY"
        && c[0].value === 91 && c[1].value === 88, JSON.stringify(c));
  }
  {
    const req = mockReq("GET", "/api/awards?candidates=1&category=dstb_tsr&scope=province&province=ALBAY");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("province DSTB candidates rank only that province's facilities with tiebreakers",
      c && c.length === 2 && /Fac B/i.test(c[0].name) && /Fac A/i.test(c[1].name), JSON.stringify(c));
  }

  // 4b. TB Preventive Treatment candidates carry TPT Accomplish and TPT Target alongside the rate.
  //     The fake nodes above set coverage_pct but not enrolled/target, so the tiebreak should fall
  //     through to null - which is what the admin table renders as a dash. Add real counts to one
  //     node to prove they are surfaced.
  {
    const { saveKpi } = require(BASE + "lib/kpiStore");
    const cur = await getCurrentKpi();
    cur.kpi.nodes["F|ALBAY|LEGAZPI|Fac A"].tpt.enrolled = 60;
    cur.kpi.nodes["F|ALBAY|LEGAZPI|Fac A"].tpt.target = 100;
    cur.kpi.nodes["F|ALBAY|TABACO|Fac B"].tpt.enrolled = 30;
    cur.kpi.nodes["F|ALBAY|TABACO|Fac B"].tpt.target = 100;
    await saveKpi(cur.kpi);
    const req = mockReq("GET", "/api/awards?candidates=1&category=tpt&scope=province&province=ALBAY");
    const res = mockRes();
    await awardsHandler(req, res);
    const c = res._body && res._body.candidates;
    check("province TPT candidates rank facilities by coverage and carry tptAccomplish/tptTarget",
      c && c.length === 2
        && /Fac A/i.test(c[0].name) && c[0].tptAccomplish === 60 && c[0].tptTarget === 100
        && /Fac B/i.test(c[1].name) && c[1].tptAccomplish === 30 && c[1].tptTarget === 100,
      JSON.stringify(c));
  }

  // 5. POST without auth is rejected.
  {
    const req = mockReq("POST", "/api/awards", { period: "2026", scope: "region", category: "cnr", level: "gold", awardee: { key: "MASBATE", name: "Masbate", value: 200 } });
    const res = mockRes();
    // isAuthenticated reads a cookie - none supplied here, so this must fail closed.
    await awardsHandler(req, res);
    check("POST without a session is rejected (401)", res._status === 401, JSON.stringify(res._body));
  }

  // 6. A save actually persists and is readable back (bypassing auth by calling the store directly,
  //    since exercising the real cookie-auth path isn't this test's concern - api/admin.js's own
  //    auth is covered by test_accounts.js).
  {
    const { setAwardSlot, getCurrentAwards } = require(BASE + "lib/awardsStore");
    await setAwardSlot({ period: "2026", scope: "region", category: "cnr", level: "gold", awardee: { key: "MASBATE", name: "Masbate", value: 200 } });
    const { awards } = await getCurrentAwards();
    check("a saved override round-trips through the store",
      awards["2026"] && awards["2026"].region.cnr.gold && awards["2026"].region.cnr.gold.key === "MASBATE",
      JSON.stringify(awards));

    const req = mockReq("GET", "/api/awards");
    const res = mockRes();
    await awardsHandler(req, res);
    check("GET /api/awards reflects the saved override",
      res._body && res._body.awards["2026"] && res._body.awards["2026"].region.cnr.gold.key === "MASBATE",
      JSON.stringify(res._body));
  }

  // 7. Clearing a slot (awardee: null) removes it rather than storing a null placeholder.
  {
    const { setAwardSlot, getCurrentAwards } = require(BASE + "lib/awardsStore");
    await setAwardSlot({ period: "2026", scope: "region", category: "cnr", level: "gold", awardee: null });
    const { awards } = await getCurrentAwards();
    check("clearing a slot deletes it rather than leaving a null value",
      awards["2026"] && !("gold" in (awards["2026"].region.cnr || {})),
      JSON.stringify(awards["2026"] && awards["2026"].region.cnr));
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nRECONSTRUCTED AWARDS API WORKS" : "\nISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
