// Thin HTTP client for the standalone consolidation server (see server/index.js). Replaces the
// in-process lib/consolidate.js + lib/kpiStore.js calls that used to run the full KPI pipeline
// directly inside this Vercel serverless function - which is what caused this app's recurring OOM
// crashes on /api/province-upload (Vercel Functions have a fixed memory ceiling; this app's total
// cumulative case data only grows every reporting period, so "hold everything in memory at once"
// was never going to keep working). The consolidation server runs on a host with as much RAM as it
// needs, and publishes the result to Blob storage itself - the (potentially very large) consolidated
// KPI JSON never has to pass back through this function's own memory, only a small confirmation does.
//
// Mirrors the return shape and error semantics of the old in-process `consolidate()` + `saveKpi()`
// pair as closely as possible, specifically including the `.code === "NOT_READY"` property every
// call site (province-upload.js, reference-upload.js, province-data.js) already checks for the
// "nothing to publish yet, but this file is genuinely fine" case - so those call sites needed only
// their consolidate()/saveKpi() lines swapped for a single call here, nothing else.
const CONSOLIDATION_SERVER_URL = process.env.CONSOLIDATION_SERVER_URL;
const CONSOLIDATION_SERVER_TOKEN = process.env.CONSOLIDATION_SERVER_TOKEN;

function configured() {
  return !!(CONSOLIDATION_SERVER_URL && CONSOLIDATION_SERVER_TOKEN);
}

/**
 * Runs a full consolidation + publish on the standalone server.
 * @param {{province?: object, reference?: object}} [overrides] - same shape lib/consolidate.js's
 *        consolidate() already accepts: the entry a caller just wrote (or deleted - use null) for
 *        one slot, so the server doesn't have to trust a fresh Blob read of this request's own
 *        just-completed write, which is not guaranteed to be visible yet.
 * @returns {Promise<{presentProvinces: string[], missingProvinces: string[]}>}
 */
async function consolidateAndPublish(overrides) {
  if (!CONSOLIDATION_SERVER_URL) {
    throw new Error(
      "CONSOLIDATION_SERVER_URL is not configured (Vercel project env vars). Set it to the deployed " +
        "consolidation server's URL - see server/README.md."
    );
  }
  if (!CONSOLIDATION_SERVER_TOKEN) {
    throw new Error("CONSOLIDATION_SERVER_TOKEN is not configured (Vercel project env vars).");
  }

  let response;
  try {
    response = await fetch(CONSOLIDATION_SERVER_URL.replace(/\/+$/, "") + "/consolidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": CONSOLIDATION_SERVER_TOKEN },
      body: JSON.stringify({ overrides: overrides || null }),
    });
  } catch (networkErr) {
    throw new Error(
      "Consolidation server unreachable: " + ((networkErr && networkErr.message) || networkErr)
    );
  }

  let body = null;
  try {
    body = await response.json();
  } catch (parseErr) {
    throw new Error(`Consolidation server returned an unreadable response (HTTP ${response.status}).`);
  }

  if (!body || typeof body !== "object") {
    throw new Error(`Consolidation server returned an unexpected response (HTTP ${response.status}).`);
  }
  if (response.status === 401) {
    throw new Error(body.error || "Consolidation server rejected this request's token.");
  }
  if (!body.ok) {
    const err = new Error(body.error || `Consolidation failed (HTTP ${response.status}).`);
    if (body.code) err.code = body.code;
    throw err;
  }
  return { presentProvinces: body.presentProvinces || [], missingProvinces: body.missingProvinces || [] };
}

module.exports = { consolidateAndPublish, configured };
