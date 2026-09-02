// Shared support for chunked uploads.
//
// WHY: Vercel Serverless Functions (Node runtime) enforce a fixed ~4.5MB request body ceiling at
// the platform/routing layer - a real filled-in province file (tens of thousands of case rows)
// routinely exceeds that, and the platform rejects the request with HTTP 413 before it ever reaches
// this project's code, regardless of maxDuration/memory settings (those only govern the function
// itself, not the platform's request-size gate).
//
// FIX: the browser splits the file into <=4MB pieces and PUTs each one to this project's own
// endpoint in turn (small requests, always under the ceiling); once every piece has arrived, a
// final tiny "finalize" request tells the server to reassemble them and hand off to the normal
// validate/store/consolidate flow, completely unchanged from before chunking existed.
//
// Temp pieces live in the SAME Blob store as everything else, under a per-upload prefix, using only
// get/put/del - the same OIDC-authenticated calls already used everywhere else in this project. No
// BLOB_READ_WRITE_TOKEN is required or used (this project's Blob store is connected via OIDC only -
// see the Storage tab - so anything requiring a static read-write token, e.g. Vercel Blob's
// client-upload token flow, is not an option here).
const TMP_PREFIX = "tmp-uploads/";

function chunkKey(uploadId, index) {
  const safeId = String(uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Missing or invalid uploadId.");
  return `${TMP_PREFIX}${safeId}/${String(index).padStart(6, "0")}.bin`;
}

/** Stores one chunk of an in-progress upload. */
async function saveChunk(uploadId, index, buffer) {
  const { put } = require("@vercel/blob");
  await put(chunkKey(uploadId, index), buffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/octet-stream",
  });
}

/** Reads every chunk of an upload back in order and concatenates them into the original file's bytes. */
async function assembleChunks(uploadId, totalChunks) {
  const { get } = require("@vercel/blob");
  const total = Number(totalChunks);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Missing or invalid totalChunks.");
  const parts = [];
  for (let i = 0; i < total; i++) {
    let result;
    try {
      result = await get(chunkKey(uploadId, i), { access: "private" });
    } catch (e) { result = null; }
    if (!result || result.statusCode !== 200 || !result.stream) {
      const err = new Error(
        `Upload piece ${i + 1} of ${total} did not arrive - the upload may have been interrupted ` +
        "partway through. Please try uploading the file again."
      );
      err.code = "CHUNK_MISSING";
      throw err;
    }
    parts.push(Buffer.from(await new Response(result.stream).arrayBuffer()));
  }
  return Buffer.concat(parts);
}

/** Best-effort cleanup of an upload's temp pieces - never allowed to fail the caller's response. */
async function cleanupChunks(uploadId, totalChunks) {
  const { del } = require("@vercel/blob");
  const total = Number(totalChunks) || 0;
  for (let i = 0; i < total; i++) {
    try { await del(chunkKey(uploadId, i)); } catch (e) { /* an orphaned temp blob is harmless */ }
  }
}

module.exports = { saveChunk, assembleChunks, cleanupChunks };
