// Standalone, always-on consolidation server (deploy target: Railway, or any host that can run a
// long-lived Node process). Exists solely to run this app's existing KPI consolidation - unchanged -
// on a machine with as much RAM as it actually needs, instead of inside a Vercel Serverless
// Function's fixed memory ceiling. This app's total cumulative case data (7 provinces x multiple
// years of TSR Cohort data) only grows every reporting period, so "reprocess everything in one
// memory-capped function invocation, on every single upload or delete" was never going to keep
// working - see HANDOVER.md's OOM section for the history.
//
// DELIBERATELY NO BUSINESS LOGIC LIVES HERE. This is a thin HTTP wrapper around the exact same
// lib/consolidate.js and lib/kpiStore.js the Vercel functions used to call in-process. Reusing those
// files unchanged (not re-implementing them here) is the whole point: this server can never compute
// a different KPI figure than the one already covered by this repo's own regression suite
// (test_consolidation_equivalence.js, test_delete_publish_integrity.js, etc still apply unchanged,
// since consolidate()/saveKpi() themselves never moved).
//
// The consolidated KPI is published to Blob storage directly from here - it never passes back
// through the calling Vercel function's own memory, only a small {presentProvinces, missingProvinces}
// confirmation does (see lib/consolidationClient.js on the Vercel side).
const express = require("express");
const { consolidate } = require("../lib/consolidate");
const { saveKpi } = require("../lib/kpiStore");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.CONSOLIDATION_SERVER_TOKEN;

if (!AUTH_TOKEN) {
  console.error(
    "FATAL: CONSOLIDATION_SERVER_TOKEN is not set. Refusing to start - without it this endpoint " +
      "would accept unauthenticated requests to rewrite the published regional dataset."
  );
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    "FATAL: BLOB_READ_WRITE_TOKEN is not set. This process is not running inside Vercel, so it has " +
      "no OIDC-based Blob auth to fall back on - a static read-write token is required. Copy one " +
      "from the Vercel project's Storage tab (Connections) and set it here."
  );
  process.exit(1);
}

const app = express();
// Province files run into the multi-MB range; the JSON body carrying a province's just-written
// entry (passed through as an `overrides` value so this endpoint doesn't have to trust a Blob
// read-back racing this same upload's own write) needs real headroom, not Express's 100kb default.
app.use(express.json({ limit: "200mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/consolidate", async (req, res) => {
  const provided = req.headers["x-internal-token"];
  if (provided !== AUTH_TOKEN) {
    res.status(401).json({ ok: false, error: "Not authenticated." });
    return;
  }
  const overrides = (req.body && req.body.overrides) || undefined;
  try {
    const consolidation = await consolidate(null, overrides);
    await saveKpi(consolidation.kpi);
    res.status(200).json({
      ok: true,
      presentProvinces: consolidation.presentProvinces,
      missingProvinces: consolidation.missingProvinces,
    });
  } catch (err) {
    console.error("Consolidation failed:", err);
    res.status(200).json({
      ok: false,
      code: (err && err.code) || null,
      error: (err && err.message) || "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Consolidation server listening on port ${PORT}`);
});
