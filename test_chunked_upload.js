// Proves the chunked-upload path (added because a real province file exceeds Vercel's fixed ~4.5MB
// Serverless Function request body ceiling - HTTP 413, before this project's code even runs) is
// equivalent to the original single-request upload: splitting a real, full-size file into pieces
// and sending them as a sequence of ?stage=chunk + one ?stage=finalize request must reassemble the
// EXACT original bytes and produce the exact same stored/published result as the old one-shot path.
const fs = require("fs");
const Module = require("module");

process.env.BLOB_READ_WRITE_TOKEN = "test-token";
process.env.SESSION_SECRET = "test-secret";

// ---------------------------------------------------------------- in-memory Blob store stub
const STORE = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "@vercel/blob") {
    return {
      async get(p) {
        if (!STORE.has(p)) { const e = new Error("not found"); e.statusCode = 404; throw e; }
        return { statusCode: 200, stream: { text: async () => STORE.get(p) }, blob: { uploadedAt: new Date().toISOString() } };
      },
      async put(p, b) {
        // Mirrors real @vercel/blob: body may be a Buffer (chunks/entries) or a string (KPI JSON).
        STORE.set(p, Buffer.isBuffer(b) ? b : String(b));
        return { url: "memory://" + p };
      },
      async del(p) { STORE.delete(p); return true; },
    };
  }
  if (request === "../lib/auth") return { isAuthenticated: () => true, getSessionIdentity: () => "master" };
  return origLoad.apply(this, arguments);
};
// get()'s stream needs .arrayBuffer() too (assembleChunks reads chunks back as binary).
global.Response = class {
  constructor(s) { this._s = s; }
  async text() { return typeof this._s.text === "function" ? this._s.text() : String(this._s); }
  async arrayBuffer() {
    const v = typeof this._s.text === "function" ? await this._s.text() : this._s;
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
};

const BASE = __dirname + "/";

// api/province-upload.js now consolidates via the standalone consolidation server (see
// lib/consolidationClient.js) instead of calling lib/consolidate.js in-process. Stub global.fetch to
// run the SAME consolidate()/saveKpi() in-process, against this file's own stubbed Blob store - this
// exercises the real HTTP request/response contract consolidationClient.js builds, without needing a
// real network call in tests.
process.env.CONSOLIDATION_SERVER_URL = "http://mock-consolidation-server.test";
process.env.CONSOLIDATION_SERVER_TOKEN = "test-consolidation-token";
const { consolidate: __mockConsolidate } = require(BASE + "lib/consolidate");
const kpiStore = require(BASE + "lib/kpiStore");
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  try {
    const consolidation = await __mockConsolidate(null, body.overrides || undefined);
    await kpiStore.saveKpi(consolidation.kpi);
    return {
      status: 200,
      json: async () => ({ ok: true, presentProvinces: consolidation.presentProvinces, missingProvinces: consolidation.missingProvinces }),
    };
  } catch (err) {
    return { status: 200, json: async () => ({ ok: false, code: err.code || null, error: err.message }) };
  }
};

const provinceUpload = require(BASE + "api/province-upload.js");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

function mockReq(method, url, body) {
  return {
    method, url, headers: {},
    on(event, cb) {
      if (event === "data" && body && body.length) cb(body);
      if (event === "end") cb();
      return this;
    },
  };
}
function mockRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(o) { this._body = o; return this; },
    send(o) { this._body = o; return this; },
    setHeader() {},
  };
}

async function sendChunked(province, buffer, chunkSize) {
  const uploadId = "test-upload-" + Math.random().toString(36).slice(2);
  const total = Math.max(1, Math.ceil(buffer.length / chunkSize));
  for (let i = 0; i < total; i++) {
    const piece = buffer.subarray(i * chunkSize, Math.min(buffer.length, (i + 1) * chunkSize));
    const req = mockReq("POST",
      "/api/province-upload?province=" + encodeURIComponent(province) + "&stage=chunk&uploadId=" + uploadId + "&index=" + i,
      piece);
    const res = mockRes();
    await provinceUpload(req, res);
    if (res._status !== 200) throw new Error("chunk " + i + " failed: " + JSON.stringify(res._body));
  }
  const req = mockReq("POST",
    "/api/province-upload?province=" + encodeURIComponent(province) +
    "&filename=" + encodeURIComponent("CamNorte.xlsx") + "&uploadedBy=Tester" +
    "&stage=finalize&uploadId=" + uploadId + "&totalChunks=" + total,
    null);
  const res = mockRes();
  await provinceUpload(req, res);
  return { res, total };
}

async function sendSingleShot(province, buffer) {
  const req = mockReq("POST",
    "/api/province-upload?province=" + encodeURIComponent(province) +
    "&filename=" + encodeURIComponent("CamNorte.xlsx") + "&uploadedBy=Tester", buffer);
  const res = mockRes();
  await provinceUpload(req, res);
  return res;
}

(async function run() {
  const buffer = fs.readFileSync(BASE + "test_fixtures_CamNorte.xlsx");
  check("fixture is realistically large (this is exactly the size class that triggers HTTP 413)",
    buffer.length > 4.5 * 1024 * 1024, buffer.length + " bytes");

  // ================================================================ 1. chunked upload, single piece
  {
    const { res, total } = await sendChunked("ALBAY", buffer, 50 * 1024 * 1024); // one chunk
    check("a single-chunk upload (whole file fits in one piece) succeeds", res._status === 200, JSON.stringify(res._body));
    check("single-chunk upload reports rows for CNR", res._body && res._body.rowCounts && res._body.rowCounts["CNR 2026 "] > 0,
      JSON.stringify(res._body && res._body.rowCounts));
    check("temp chunk blob was cleaned up after finalize",
      !Array.from(STORE.keys()).some((k) => k.startsWith("tmp-uploads/")), Array.from(STORE.keys()).filter((k) => k.startsWith("tmp-uploads/")));
  }

  // ================================================================ 2. chunked upload, many pieces - must reassemble byte-identical to a real 4MB-chunked upload and match the single-shot result exactly
  let chunkedKpi, singleShotKpi;
  {
    const { res: chunkedRes } = await sendChunked("MASBATE", buffer, 4 * 1024 * 1024); // real chunk size used by admin.js
    check("a real multi-chunk upload (4MB pieces, matching admin.js) succeeds", chunkedRes._status === 200, JSON.stringify(chunkedRes._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    chunkedKpi = kpi;
    check("multi-chunk upload's rows made it into the published KPI",
      kpi && kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr.notified > 0,
      kpi && JSON.stringify(kpi.nodes["P|MASBATE"] && kpi.nodes["P|MASBATE"].cnr));
  }
  {
    // Same file, uploaded the OLD way (whole body in one request) to a DIFFERENT province slot, so
    // the two results can be compared directly - chunking must be purely a transport detail with
    // zero effect on the parsed/validated/consolidated output.
    const singleRes = await sendSingleShot("SORSOGON", buffer);
    check("single-shot upload (for comparison) succeeds", singleRes._status === 200, JSON.stringify(singleRes._body));
    const { kpi } = await kpiStore.getCurrentKpi();
    singleShotKpi = kpi;
    // Compare everything EXCEPT population-normalized fields (rate_per_100k and friends) - those
    // legitimately differ between MASBATE and SORSOGON because each province has its own population
    // in the fixture's POPULATION sheet. What actually proves the chunk-reassembled bytes are
    // identical to the single-shot bytes is that every raw, non-population-derived figure - case
    // counts, breakdowns by sex/age/facility/etc - comes out byte-for-byte the same either way.
    const strip = (cnr) => { const c = Object.assign({}, cnr); delete c.rate_per_100k; delete c.population_basis; return c; };
    const m = singleShotKpi && singleShotKpi.nodes["P|MASBATE"] && strip(singleShotKpi.nodes["P|MASBATE"].cnr);
    const s = singleShotKpi && singleShotKpi.nodes["P|SORSOGON"] && strip(singleShotKpi.nodes["P|SORSOGON"].cnr);
    check("MASBATE (chunked) and SORSOGON (single-shot) - the same source file uploaded via each " +
      "path - produced identical CNR figures (aside from population-normalized rates, which " +
      "legitimately differ per province)",
      m && s && JSON.stringify(m) === JSON.stringify(s),
      JSON.stringify({ masbate: m, sorsogon: s }));
  }

  // ================================================================ 3. a missing chunk is caught, not silently mis-assembled
  {
    const uploadId = "test-missing-chunk";
    // Save only chunk 0 of what claims to be a 3-chunk upload, then finalize.
    const req0 = mockReq("POST",
      "/api/province-upload?province=CATANDUANES&stage=chunk&uploadId=" + uploadId + "&index=0",
      buffer.subarray(0, 1024));
    await provinceUpload(req0, mockRes());
    const reqF = mockReq("POST",
      "/api/province-upload?province=CATANDUANES&filename=x.xlsx&uploadedBy=Tester" +
      "&stage=finalize&uploadId=" + uploadId + "&totalChunks=3", null);
    const resF = mockRes();
    await provinceUpload(reqF, resF);
    check("finalizing with a missing piece fails loudly instead of processing a truncated file",
      resF._status !== 200 && /piece/i.test((resF._body && resF._body.error) || ""),
      JSON.stringify(resF._body));
  }

  // ================================================================ 4. the old no-stage path (tests, direct API callers) still works untouched
  {
    const res = await sendSingleShot("NAGA CITY", buffer);
    check("the legacy single-request path (no ?stage=) still works for small/direct callers",
      res._status === 200, JSON.stringify(res._body));
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + JSON.stringify(d)));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nCHUNKED UPLOAD WORKS" : "\nCHUNKED UPLOAD ISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
