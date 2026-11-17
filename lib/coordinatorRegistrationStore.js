const crypto = require("crypto");

const PATHNAME = "ntp-coordinator/registrations.json";

function blobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

async function getAll() {
  if (blobConfigured()) {
    try {
      const { get } = require("@vercel/blob");
      const result = await get(PATHNAME, { access: "private" });
      if (result && result.statusCode === 200 && result.stream) {
        const text = await new Response(result.stream).text();
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : [];
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/not\s*found|404|no such/i.test(msg)) {
        console.error("coordinatorRegistrationStore.getAll: Blob read failed:", err);
      }
    }
  }
  return [];
}

async function saveAll(items) {
  if (!blobConfigured()) {
    throw new Error("No Blob store connected. Connect a Vercel Blob store to persist registrations.");
  }
  const { put } = require("@vercel/blob");
  await put(PATHNAME, JSON.stringify(items), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

module.exports = { PATHNAME, blobConfigured, getAll, saveAll, newId };
