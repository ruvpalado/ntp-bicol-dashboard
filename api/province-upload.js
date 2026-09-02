// POST /api/province-upload?province=ALBAY&filename=albay.xlsx&uploadedBy=Name
//   Body: raw file bytes (Content-Type: application/octet-stream).
//   Validates the file against the province template, stores it in that province's isolated slot,
//   then re-consolidates every province + the regional master and publishes the new regional KPIs -
//   all in this one request, automatically.
//
// Rollback semantics: the province slot is only written AFTER validation passes, and the published
// regional dataset is only replaced AFTER consolidation succeeds. If consolidation throws, the
// slot is rolled back to its previous contents and the previously published KPI dataset stays
// exactly as it was.
//
// CHUNKED UPLOAD (?stage=chunk / ?stage=finalize): a real province file easily exceeds Vercel's
// fixed ~4.5MB Serverless Function request body ceiling (HTTP 413, enforced before this code ever
// runs - see lib/chunkedUpload.js). admin.js's client JS always splits the file into <=4MB pieces
// and sends them as a sequence of ?stage=chunk requests, then one ?stage=finalize request with no
// body - this reassembles the pieces and falls straight through into the exact same
// validate/store/consolidate logic below, unchanged. The plain, no-stage path (whole file as the
// request body) still works too - kept for the test suite and any direct API caller uploading
// something small enough to fit in one request.
const { isAuthenticated } = require("../lib/auth");
const { readRawBody, query } = require("../lib/httpUtil");
const { findProvince, parseUpload, validateProvinceUpload } = require("../lib/provinceTemplate");
const {
  getProvinceEntry, saveProvinceEntry, deleteProvinceEntry, appendHistory, blobConfigured,
} = require("../lib/provinceStore");
const { consolidateAndPublish } = require("../lib/consolidationClient");
const { saveChunk, assembleChunks, cleanupChunks } = require("../lib/chunkedUpload");

async function handleChunk(req, res) {
  const uploadId = query(req, "uploadId");
  const index = Number(query(req, "index"));
  if (!uploadId || !Number.isFinite(index) || index < 0) {
    res.status(400).json({ error: "Missing or invalid uploadId/index." });
    return;
  }
  try {
    const buffer = await readRawBody(req);
    if (!buffer || !buffer.length) throw new Error("Empty chunk received.");
    await saveChunk(uploadId, index, buffer);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Province upload chunk failed:", err);
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  if (!blobConfigured()) {
    res.status(500).json({
      error: "No Blob store is connected, so uploads cannot be stored. Connect one in the Vercel Storage tab.",
    });
    return;
  }

  const stage = query(req, "stage");
  if (stage === "chunk") {
    await handleChunk(req, res);
    return;
  }

  const provinceId = query(req, "province");
  const filename = query(req, "filename") || "upload.xlsx";
  const uploadedBy = (query(req, "uploadedBy") || "").trim();
  const singleSheet = query(req, "sheet") || null;
  const uploadId = query(req, "uploadId");
  const totalChunks = query(req, "totalChunks");

  if (!uploadedBy) {
    res.status(400).json({ error: "\"Uploaded by\" is required so the history log records who made this change." });
    return;
  }

  const province = findProvince(provinceId);
  if (!province) {
    res.status(400).json({ error: `Unknown province slot "${provinceId}".` });
    return;
  }
  const label = province.label;

  // Keep the current slot contents so a failed consolidation can be rolled back.
  let previousEntry = null;
  try {
    previousEntry = await getProvinceEntry(province.id);
  } catch (e) { /* nothing stored yet */ }

  try {
    const buffer = stage === "finalize"
      ? await assembleChunks(uploadId, totalChunks)
      : await readRawBody(req);
    if (!buffer || !buffer.length) throw new Error("No file data received.");
    if (stage === "finalize") cleanupChunks(uploadId, totalChunks).catch(() => {});

    // --- parse + validate (rejects bad format / schema mismatch before anything is stored) ---
    const parsed = parseUpload(buffer, filename, { singleSheet });
    const result = validateProvinceUpload(parsed, province.id);

    if (!result.ok) {
      await appendHistory({
        action: "upload-rejected", target: label, uploadedBy, filename,
        ok: false, message: result.errors.join(" "),
      });
      res.status(400).json({ error: result.errors.join("\n"), errors: result.errors, warnings: result.warnings });
      return;
    }

    // --- store into the isolated slot ---
    const entry = {
      provinceId: province.id,
      sheets: result.sheets,
      rowCounts: result.rowCounts,
      // Region-wide sheets (POPULATION, Facility List, ...) carried inside this province's
      // Format.xlsx. NOT merged per province - consolidation takes each from a single file, since
      // every province's copy describes the same region.
      regionalSheets: result.regionalSheets || {},
      meta: {
        filename,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
        warnings: result.warnings,
      },
    };
    await saveProvinceEntry(province.id, entry);

    // --- re-consolidate and publish (on the standalone consolidation server - see
    // lib/consolidationClient.js); roll the slot back if this fails ---
    let consolidation;
    try {
      // Pass the entry just saved straight through rather than trusting a fresh read of it back
      // from Blob storage - a get() immediately after this request's own put() is not guaranteed
      // to see it, which would otherwise consolidate as if this upload had never happened.
      consolidation = await consolidateAndPublish({ province: { [province.id]: entry } });
    } catch (consErr) {
      if (consErr.code === "NOT_READY") {
        // This province's file is genuinely fine - there's just no POPULATION source anywhere yet
        // (e.g. a province uploaded its case data before the region-wide Population reference was
        // set up). Rolling it back here would discard a valid upload purely because of upload order,
        // forcing the admin to re-upload the same file again later. Keep it stored; nothing is
        // published yet (there's nothing to compute rates against), and the response says so plainly.
        await appendHistory({
          action: "upload", target: label, uploadedBy, filename,
          rowCounts: result.rowCounts, ok: true,
          message: `Saved. Regional dashboard not yet rebuilt: ${consErr.message}`,
        });
        res.status(200).json({
          ok: true,
          target: label,
          rowCounts: result.rowCounts,
          warnings: result.warnings,
          notPublished: true,
          notPublishedReason: consErr.message,
          presentProvinces: [],
          missingProvinces: [],
        });
        return;
      }
      // Restore the slot to its previous contents so the stored state matches the published data.
      try {
        if (previousEntry) await saveProvinceEntry(province.id, previousEntry);
        else await deleteProvinceEntry(province.id);
      } catch (rbErr) {
        console.error("Rollback failed after consolidation error:", rbErr);
      }
      await appendHistory({
        action: "consolidation-failed", target: label, uploadedBy, filename,
        rowCounts: result.rowCounts, ok: false, message: consErr.message,
      });
      res.status(400).json({
        error: "File was valid, but consolidation failed so nothing was published: " + consErr.message +
               "\nThe previous dataset is still live.",
      });
      return;
    }

    await appendHistory({
      action: "upload", target: label, uploadedBy, filename,
      rowCounts: result.rowCounts, ok: true,
      message: `Consolidated ${consolidation.presentProvinces.length} province dataset(s).`,
    });

    res.status(200).json({
      ok: true,
      target: label,
      rowCounts: result.rowCounts,
      warnings: result.warnings,
      presentProvinces: consolidation.presentProvinces,
      missingProvinces: consolidation.missingProvinces,
    });
  } catch (err) {
    console.error("Province upload failed:", err);
    await appendHistory({
      action: "upload-failed", target: label, uploadedBy, filename,
      ok: false, message: (err && err.message) || "Unknown error",
    }).catch(() => {});
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
