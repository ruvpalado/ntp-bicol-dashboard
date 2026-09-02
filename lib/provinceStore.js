// Blob-backed storage for the per-province upload slots and the upload history log. Mirrors kpiStore.js/awardsStore.js exactly in structure and auth mode
// (BLOB_READ_WRITE_TOKEN or OIDC BLOB_STORE_ID; private access via get()/put()).
//
// Isolation: each province lives at its own blob pathname, so writing Albay's file physically
// cannot touch Camarines Sur's data. Consolidation reads them all and merges into a fresh copy.
const { PROVINCE_SLOTS, REFERENCE_SLOTS, findProvince, findReferenceSlot } = require("./provinceTemplate");

const PROVINCE_PREFIX = "ntp-province/";
const REFERENCE_PREFIX = "ntp-reference/";
const HISTORY_PATHNAME = "ntp-province/_history.json";
const MAX_HISTORY_ENTRIES = 200;

function blobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

function requireBlob() {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab) so province uploads can persist."
    );
  }
}

function provinceSlug(provinceId) {
  return String(provinceId).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function provincePathname(provinceId) {
  return PROVINCE_PREFIX + provinceSlug(provinceId) + ".json";
}

// Separate prefix from the province files, so a reference upload can never overwrite an area's
// dataset even if the two ever shared an id.
function referencePathname(slotId) {
  return REFERENCE_PREFIX + provinceSlug(slotId) + ".json";
}

async function readJson(pathname) {
  if (!blobConfigured()) return null;
  try {
    const { get } = require("@vercel/blob");
    const result = await get(pathname, { access: "private" });
    if (result && result.statusCode === 200 && result.stream) {
      const text = await new Response(result.stream).text();
      const parsed = JSON.parse(text);
      // A tombstoned slot (see deleteJson below) reads back as present but must behave as absent -
      // this is what makes "deleted" durable even when the underlying object was never actually
      // removed from the store.
      if (parsed && typeof parsed === "object" && parsed.__deleted === true) return null;
      return parsed;
    }
  } catch (err) {
    // A missing blob is the normal "nothing uploaded yet" case - don't treat it as an error.
    const msg = String((err && err.message) || err);
    if (!/not\s*found|404|no such/i.test(msg)) {
      console.error("provinceStore.readJson failed for", pathname, err);
    }
  }
  return null;
}

async function writeJson(pathname, value) {
  requireBlob();
  const { put } = require("@vercel/blob");
  return put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

// Deletion is implemented as an overwrite, not a removal. Production logs showed the previous
// del()-then-verify-with-get() approach's diagnostic warning firing repeatedly, for the SAME
// pathnames (CAMARINES_SUR.json, NAGA_CITY.json, CAMARINES_NORTE.json, ALBAY.json), across more
// than a week - not a one-off millisecond-scale race. consolidate.js's `overrides` parameter only
// protects the one request that performed the delete; any LATER, unrelated consolidation (triggered
// by a different province's own upload or delete) calls getAllProvinceEntries() fresh with no
// override, and if del() had not durably taken effect it would read the "deleted" file straight back
// and republish it - exactly the reported symptom ("still showing data even [after it's] deleted...
// specially camarines sur").
//
// Fix: write an explicit tombstone marker via put() instead of calling del(). Every read path in
// this file (readJson, above) already treats a tombstone as absent. This trades "delete-then-absent"
// consistency - which this store has shown to be unreliable - for "put-then-read" consistency, which
// is the SAME guarantee every upload in this app already depends on and has never shown this problem.
// The real underlying object is still deleted afterward, best-effort, purely for storage hygiene;
// nothing depends on that succeeding or being fast.
async function deleteJson(pathname) {
  requireBlob();
  await writeJson(pathname, { __deleted: true, deletedAt: new Date().toISOString() });
  try {
    const { del } = require("@vercel/blob");
    await del(pathname);
  } catch (err) {
    // Irrelevant to correctness - the tombstone above is what every reader honors. Not logged as an
    // error to avoid resurrecting the same noisy-but-meaningless alerts this fix removes.
  }
}

// ---------------------------------------------------------------- province datasets

/** @returns {null | {provinceId, sheets, rowCounts, meta}} */
async function getProvinceEntry(provinceId) {
  const p = findProvince(provinceId);
  if (!p) return null;
  return readJson(provincePathname(p.id));
}

/** Reads every province slot. Missing slots come back as null (rendered "No file uploaded"). */
async function getAllProvinceEntries() {
  const out = {};
  for (const slot of PROVINCE_SLOTS) {
    out[slot.id] = await getProvinceEntry(slot.id);
  }
  return out;
}

async function saveProvinceEntry(provinceId, entry) {
  const p = findProvince(provinceId);
  if (!p) throw new Error(`Unknown province slot "${provinceId}".`);
  // Only one file per province: this overwrites the slot rather than appending.
  return writeJson(provincePathname(p.id), entry);
}

async function deleteProvinceEntry(provinceId) {
  const p = findProvince(provinceId);
  if (!p) throw new Error(`Unknown province slot "${provinceId}".`);
  await deleteJson(provincePathname(p.id));
}

// ---------------------------------------------------------------- region-wide reference data

/** @returns {null | {slotId, sheets, rowCounts, meta}} */
async function getReferenceEntry(slotId) {
  const s = findReferenceSlot(slotId);
  if (!s) return null;
  return readJson(referencePathname(s.id));
}

/** Reads every reference slot. Missing slots come back as null. */
async function getAllReferenceEntries() {
  const out = {};
  for (const slot of REFERENCE_SLOTS) {
    out[slot.id] = await getReferenceEntry(slot.id);
  }
  return out;
}

async function saveReferenceEntry(slotId, entry) {
  const s = findReferenceSlot(slotId);
  if (!s) throw new Error(`Unknown reference slot "${slotId}".`);
  // One file per slot, same as the province slots: this overwrites rather than appends.
  return writeJson(referencePathname(s.id), entry);
}

async function deleteReferenceEntry(slotId) {
  const s = findReferenceSlot(slotId);
  if (!s) throw new Error(`Unknown reference slot "${slotId}".`);
  await deleteJson(referencePathname(s.id));
}

// ---------------------------------------------------------------- upload history log

async function getHistory() {
  const h = await readJson(HISTORY_PATHNAME);
  return Array.isArray(h) ? h : [];
}

/**
 * Appends an audit entry. Newest first, capped so the log can't grow unbounded.
 * @param {{action:string, target:string, uploadedBy:string, filename?:string,
 *          rowCounts?:object, ok:boolean, message?:string}} entry
 */
async function appendHistory(entry) {
  const history = await getHistory();
  history.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);
  await writeJson(HISTORY_PATHNAME, trimmed);
  return trimmed;
}

/**
 * Wipes the upload history log back to empty. Used by the admin page's "Clear History" action -
 * removes only the recorded entries themselves, leaving every province/reference dataset and the
 * published dashboard untouched.
 */
async function clearHistory() {
  await writeJson(HISTORY_PATHNAME, []);
  return [];
}

module.exports = {
  blobConfigured,
  provincePathname,
  referencePathname,
  getProvinceEntry,
  getAllProvinceEntries,
  saveProvinceEntry,
  deleteProvinceEntry,
  getReferenceEntry,
  getAllReferenceEntries,
  saveReferenceEntry,
  deleteReferenceEntry,
  getHistory,
  appendHistory,
  clearHistory,
};
