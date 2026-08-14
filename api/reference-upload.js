// POST   /api/reference-upload?slot=POPULATION&filename=pop.xlsx&uploadedBy=Name
//          Body: raw file bytes (Content-Type: application/octet-stream).
// DELETE /api/reference-upload?slot=POPULATION&uploadedBy=Name
//
// Region-wide reference data (Population, Facility List) uploaded once for the whole region rather
// than per province. These sheets are the denominators and the facility->province map behind every
// figure on the dashboard, so an uploaded file here is authoritative: consolidation prefers it over
// the copies embedded in the provincial files.
//
// Rollback semantics mirror the province endpoint: on upload, the slot is only written AFTER
// validation passes, and the published regional dataset is only replaced AFTER consolidation
// succeeds - if consolidation throws, the slot is restored and the previously published KPIs stay
// live, since that previous state is still internally consistent. On delete there is nothing to
// roll the slot back to (the file really is gone), so if consolidation can't produce a usable
// dataset from what remains, the published KPI is unpublished instead of left showing the deleted
// file's numbers.
const { isAuthenticated } = require("../lib/auth");
const { readRawBody, query } = require("../lib/httpUtil");
const { clearKpi } = require("../lib/kpiStore");
const { findReferenceSlot, parseUpload, validateReferenceUpload } = require("../lib/provinceTemplate");
const {
  getReferenceEntry, saveReferenceEntry, deleteReferenceEntry, appendHistory, blobConfigured,
} = require("../lib/provinceStore");
const { consolidateAndPublish } = require("../lib/consolidationClient");
const { saveChunk, assembleChunks, cleanupChunks } = require("../lib/chunkedUpload");

// See api/province-upload.js for why chunked upload exists (Vercel's fixed ~4.5MB request body
// ceiling) and how it works.
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
    console.error("Reference upload chunk failed:", err);
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

async function handleDelete(req, res, slot, uploadedBy) {
  try {
    await deleteReferenceEntry(slot.id);
    // Re-consolidate on what remains: the region-wide sheets fall back to the provincial copies.
    // If that leaves nothing usable (e.g. this was the only POPULATION source and no province file
    // carries one either), the published KPI is unpublished rather than left showing figures that
    // depended on the file that was just deleted.
    let message = `${slot.label} reference file removed.`;
    try {
      // Force this slot out of consolidation regardless of whether Blob storage's read-back has
      // caught up with the delete() just issued - see province-data.js's DELETE handler for why.
      const consolidation = await consolidateAndPublish({ reference: { [slot.id]: null } });
      message += ` Regional view rebuilt from ${consolidation.presentProvinces.length} province dataset(s).`;
    } catch (consErr) {
      await clearKpi();
      message += " No regional view is currently published: " + consErr.message;
    }
    await appendHistory({ action: "delete", target: slot.label + " (reference)", uploadedBy, ok: true, message });
    res.status(200).json({ ok: true, message });
  } catch (err) {
    console.error("Reference delete failed:", err);
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "DELETE") {
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
  if (req.method === "POST" && stage === "chunk") {
    await handleChunk(req, res);
    return;
  }

  const slotId = query(req, "slot");
  const filename = query(req, "filename") || "reference.xlsx";
  const uploadedBy = (query(req, "uploadedBy") || "").trim();
  const singleSheet = query(req, "sheet") || null;
  const uploadId = query(req, "uploadId");
  const totalChunks = query(req, "totalChunks");

  const slot = findReferenceSlot(slotId);
  if (!slot) {
    res.status(400).json({ error: `Unknown reference slot "${slotId}".` });
    return;
  }
  if (!uploadedBy) {
    res.status(400).json({ error: "\"Uploaded by\" is required so the history log records who made this change." });
    return;
  }

  if (req.method === "DELETE") {
    await handleDelete(req, res, slot, uploadedBy);
    return;
  }

  const label = slot.label;

  // Keep the current slot contents so a failed consolidation can be rolled back.
  let previousEntry = null;
  try {
    previousEntry = await getReferenceEntry(slot.id);
  } catch (e) { /* nothing stored yet */ }

  try {
    const buffer = stage === "finalize"
      ? await assembleChunks(uploadId, totalChunks)
      : await readRawBody(req);
    if (!buffer || !buffer.length) throw new Error("No file data received.");
    if (stage === "finalize") cleanupChunks(uploadId, totalChunks).catch(() => {});

    // A single-table CSV can't say which sheet it is, so it is read as the slot's primary sheet.
    const parsed = parseUpload(buffer, filename, { singleSheet: singleSheet || slot.sheets[0] });
    const result = validateReferenceUpload(parsed, slot.id);

    if (!result.ok) {
      await appendHistory({
        action: "upload-rejected", target: label + " (reference)", uploadedBy, filename,
        ok: false, message: result.errors.join(" "),
      });
      res.status(400).json({ error: result.errors.join("\n"), errors: result.errors, warnings: result.warnings });
      return;
    }

    const entry = {
      slotId: slot.id,
      sheets: result.sheets,
      rowCounts: result.rowCounts,
      meta: {
        filename,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
        warnings: result.warnings,
      },
    };
    await saveReferenceEntry(slot.id, entry);

    let consolidation;
    try {
      // See province-upload.js: pass the entry just saved straight through rather than trusting a
      // fresh Blob read of it back, which isn't guaranteed to see this request's own write yet.
      consolidation = await consolidateAndPublish({ reference: { [slot.id]: entry } });
    } catch (consErr) {
      if (consErr.code === "NOT_READY") {
        // This file is genuinely fine - there just isn't enough uploaded YET to publish a dashboard
        // (e.g. Facility List was uploaded before Population). Rolling it back here would silently
        // discard a valid upload just because of upload ORDER, forcing the admin to re-upload it
        // again later for no reason. Keep it stored; nothing is published (there's nothing to
        // publish), and the response says so plainly rather than presenting this as a rejection.
        await appendHistory({
          action: "upload", target: label + " (reference)", uploadedBy, filename,
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
      // A genuine, unexpected consolidation failure (not just "not enough uploaded yet") - roll the
      // slot back to what it held before, so stored state doesn't drift from what's published.
      try {
        if (previousEntry) await saveReferenceEntry(slot.id, previousEntry);
        else await deleteReferenceEntry(slot.id);
      } catch (rbErr) {
        console.error("Rollback failed after consolidation error:", rbErr);
      }
      await appendHistory({
        action: "consolidation-failed", target: label + " (reference)", uploadedBy, filename,
        rowCounts: result.rowCounts, ok: false, message: consErr.message,
      });
      res.status(400).json({
        error: "File was valid, but consolidation failed so nothing was published: " + consErr.message +
               "\nThe previous dataset is still live.",
      });
      return;
    }

    await appendHistory({
      action: "upload", target: label + " (reference)", uploadedBy, filename,
      rowCounts: result.rowCounts, ok: true,
      message: `Now used region-wide. Consolidated ${consolidation.presentProvinces.length} province dataset(s).`,
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
    console.error("Reference upload failed:", err);
    await appendHistory({
      action: "upload-failed", target: label + " (reference)", uploadedBy, filename,
      ok: false, message: (err && err.message) || "Unknown error",
    }).catch(() => {});
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
