// Holds the published regional KPI dataset - the output of consolidating the uploaded provincial
// files - in Vercel Blob, so it survives across serverless invocations and updates for every
// visitor the moment a province uploads, with no redeploy.
//
// SINGLE SOURCE OF TRUTH: there is deliberately no bundled seed dataset any more. Every figure the
// dashboard shows is computed from the provincial files that have actually been uploaded; if none
// have been, getCurrentKpi() returns null and the site says so rather than presenting stale or
// pre-baked numbers as if they were current.
//
// Vercel Blob supports two auth modes and the SDK picks whichever is present automatically: the
// legacy static BLOB_READ_WRITE_TOKEN, or the newer OIDC mode (BLOB_STORE_ID + an auto-refreshed
// VERCEL_OIDC_TOKEN). Connecting a Blob store via the dashboard's Storage tab provisions OIDC by
// default, so BLOB_READ_WRITE_TOKEN may never appear even when a store IS connected - check either.
//
// The store uses private access, so this uses get()/put() with access:"private" rather than a
// public URL - public blob URLs 404 against a private-access store.
const CURRENT_PATHNAME = "ntp-kpi/current.json";

function blobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

/**
 * @returns {{kpi: object|null, source: string, updatedAt: string|null}}
 *          kpi is null when nothing has been consolidated yet.
 */
async function getCurrentKpi() {
  if (blobConfigured()) {
    try {
      const { get } = require("@vercel/blob");
      const result = await get(CURRENT_PATHNAME, { access: "private" });
      if (result && result.statusCode === 200 && result.stream) {
        const text = await new Response(result.stream).text();
        const parsed = JSON.parse(text);
        // A tombstoned publish (see clearKpi below) reads back as present but must behave as
        // "nothing published" - this is what makes clearKpi durable even if the underlying object
        // was never actually removed from the store.
        if (parsed && typeof parsed === "object" && parsed.__deleted === true) {
          return { kpi: null, source: "none", updatedAt: null };
        }
        return { kpi: parsed, source: "provincial-uploads", updatedAt: result.blob.uploadedAt };
      }
    } catch (err) {
      // A missing blob is the normal "no uploads yet" case, not an error worth logging.
      const msg = String((err && err.message) || err);
      if (!/not\s*found|404|no such/i.test(msg)) {
        console.error("kpiStore.getCurrentKpi: Blob read failed:", err);
      }
    }
  }
  return { kpi: null, source: "none", updatedAt: null };
}

async function saveKpi(kpiJson) {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) " +
        "so consolidated results can persist - see README."
    );
  }
  const { put } = require("@vercel/blob");
  const blob = await put(CURRENT_PATHNAME, JSON.stringify(kpiJson), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return blob;
}

// Unpublishes the current regional dataset entirely (getCurrentKpi() goes back to returning
// kpi: null, and GET / falls back to its "awaiting uploads" page). Used after a delete leaves
// nothing valid to re-consolidate - deleting an area's only upload, or the region's only
// POPULATION source - so the deleted data does not linger on the public dashboard just because
// there was nothing left to recompute it from. A missing blob is a no-op, not an error.
// Unpublishing is implemented as an overwrite, not a removal, for the same reason
// lib/provinceStore.js's deleteJson() now works this way: this Blob store has shown del()-then-absent
// consistency to be unreliable (the diagnostic below used to log a post-delete get() succeeding
// repeatedly, for the same pathname, across days) - and getCurrentKpi() is read on EVERY visit to the
// public dashboard, so a stale, "already cleared" KPI reappearing here is exactly as visible as the
// province-resurfacing bug this mirrors. Writing an explicit tombstone via put() instead relies on
// put()-then-read() consistency, which every publish (saveKpi, above) already depends on successfully.
async function clearKpi() {
  if (!blobConfigured()) return;
  try {
    const { put } = require("@vercel/blob");
    await put(CURRENT_PATHNAME, JSON.stringify({ __deleted: true, clearedAt: new Date().toISOString() }), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    console.error("kpiStore.clearKpi: Blob tombstone write failed:", err);
  }
  // Best-effort real cleanup, purely for storage hygiene - the tombstone above is what
  // getCurrentKpi() actually honors, so nothing depends on this succeeding.
  try {
    const { del } = require("@vercel/blob");
    await del(CURRENT_PATHNAME);
  } catch (err) { /* irrelevant to correctness */ }
}

module.exports = { getCurrentKpi, saveKpi, clearKpi, blobConfigured };
