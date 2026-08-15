// Blob storage for Awardee Recognition assignments - same single-JSON-document pattern as
// kpiStore.js (see that file's comments for the OIDC/BLOB_READ_WRITE_TOKEN auth-mode note, which
// applies here too). Keyed by recognition period (year):
//   { "<year>": { region: { "<category>": {gold,silver,bronze} },
//                  provinces: { "<PROVINCE>": { "<category>": {gold,silver,bronze} } } } }
// Small scale (a handful of categories/levels per period), so one document is simplest.
const CURRENT_PATHNAME = "ntp-awards/current.json";

function blobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

async function getCurrentAwards() {
  if (blobConfigured()) {
    try {
      const { get } = require("@vercel/blob");
      const result = await get(CURRENT_PATHNAME, { access: "private" });
      if (result && result.statusCode === 200 && result.stream) {
        const text = await new Response(result.stream).text();
        return { awards: JSON.parse(text), source: "admin-assigned", updatedAt: result.blob.uploadedAt };
      }
    } catch (err) {
      // A missing blob is the normal "nothing assigned yet" case, not an error worth logging.
      const msg = String((err && err.message) || err);
      if (!/not\s*found|404|no such/i.test(msg)) {
        console.error("awardsStore.getCurrentAwards: Blob read failed:", err);
      }
    }
  }
  return { awards: {}, source: "none", updatedAt: null };
}

async function saveAwards(awardsJson) {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) " +
        "so Awardee Recognition assignments can persist."
    );
  }
  const { put } = require("@vercel/blob");
  const blob = await put(CURRENT_PATHNAME, JSON.stringify(awardsJson), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return blob;
}

/** Sets (awardee given) or clears (awardee null/falsy) one gold/silver/bronze slot. */
async function setAwardSlot({ period, scope, province, category, level, awardee }) {
  const { awards } = await getCurrentAwards();
  if (!awards[period]) awards[period] = { region: {}, provinces: {} };
  const periodData = awards[period];
  let board;
  if (scope === "region") {
    if (!periodData.region[category]) periodData.region[category] = {};
    board = periodData.region[category];
  } else {
    if (!periodData.provinces[province]) periodData.provinces[province] = {};
    if (!periodData.provinces[province][category]) periodData.provinces[province][category] = {};
    board = periodData.provinces[province][category];
  }
  if (awardee) board[level] = awardee;
  else delete board[level];
  await saveAwards(awards);
  return awards;
}

// Per-area activation date/time for the Awardee & Recognition module (System Scheduling
// requirement: each province, and Naga City, activates independently - e.g. on its own DQC (Data
// Quality Check) commencement date/time - rather than the whole module switching on at once).
//
// Each area is stored at its OWN blob pathname (ntp-awards/activation/<AREA>.json), one file per
// area - mirroring provinceStore.js's province-slot isolation exactly, and for the same reason.
// An earlier version of this stored every area's date in ONE shared JSON document (read the whole
// map, change one key, write the whole map back). That has a lost-update race: if two areas are
// saved close together (e.g. an admin clicking Save down a list of 7 rows), the second write's
// read can happen before the first write lands, so its write-back silently drops the first area's
// entry - in production this showed up as only a couple of the areas an admin had just set actually
// keeping their date after saving several in a row. Giving each area its own pathname removes the
// shared document entirely, so saving one area can no longer race with, or clobber, another area's
// save - the exact same isolation guarantee provinceStore.js already relies on for province uploads.
//
// A missing/tombstoned file means "not yet configured" for that area specifically - see
// vendor/dashboard_js_full.txt's isAreaActivated()/isAwardsActiveForCurrentPage() for how an
// unconfigured area always stays visible by default, while a configured-but-future date gates only
// that one area.
const ACTIVATION_PREFIX = "ntp-awards/activation/";

function activationSlug(area) {
  return String(area || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
function activationPathname(area) {
  return ACTIVATION_PREFIX + activationSlug(area) + ".json";
}

/** @returns {Promise<string|null>} that one area's stored datetime-local value, or null if unset. */
async function getActivationDate(area) {
  if (!blobConfigured()) return null;
  const pathname = activationPathname(area);
  try {
    const { get } = require("@vercel/blob");
    const result = await get(pathname, { access: "private" });
    if (result && result.statusCode === 200 && result.stream) {
      const text = await new Response(result.stream).text();
      const parsed = JSON.parse(text);
      // A tombstoned area (see setActivationDate's clear path below) reads back as present but
      // must behave as absent - same durable-delete approach provinceStore.js uses, for the same
      // reason (a bare del() was found, in production, to not reliably take effect immediately).
      if (parsed && typeof parsed === "object" && parsed.__deleted === true) return null;
      return (parsed && typeof parsed.date === "string" && parsed.date) ? parsed.date : null;
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/not\s*found|404|no such/i.test(msg)) {
      console.error("awardsStore.getActivationDate: Blob read failed for", pathname, err);
    }
  }
  return null;
}

/** @returns {Promise<Object<string,string>>} { "<AREA>": "<datetime-local value>" }, {} if none set. */
async function getActivationDates() {
  const { PROVINCE_SLOTS } = require("./provinceTemplate");
  const out = {};
  await Promise.all(PROVINCE_SLOTS.map(async (slot) => {
    const iso = await getActivationDate(slot.id);
    if (iso) out[slot.id] = iso;
  }));
  return out;
}

/**
 * Sets (or, given a falsy value, clears) one area's activation date/time. Writes only that area's
 * own blob - structurally cannot touch, race with, or clobber any other area's value.
 * @param {string} area - a PROVINCE_SLOTS id, e.g. "ALBAY" or "NAGA CITY".
 * @param {string|null} iso - a datetime-local value (e.g. "2026-09-01T08:00") or null to clear.
 */
async function setActivationDate(area, iso) {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) " +
        "so activation dates can persist."
    );
  }
  const key = activationSlug(area);
  if (!key) throw new Error("An area is required to set its activation date.");
  const pathname = activationPathname(area);
  const { put } = require("@vercel/blob");
  const value = (iso && String(iso).trim()) ? String(iso).trim() : null;
  if (value) {
    return put(pathname, JSON.stringify({ date: value }), {
      access: "private", contentType: "application/json",
      allowOverwrite: true, addRandomSuffix: false,
    });
  }
  // Clear: same tombstone-then-best-effort-delete pattern as provinceStore.deleteJson - a durable
  // "put" that every reader already treats as absent, rather than relying on del() alone.
  const blob = await put(pathname, JSON.stringify({ __deleted: true, deletedAt: new Date().toISOString() }), {
    access: "private", contentType: "application/json",
    allowOverwrite: true, addRandomSuffix: false,
  });
  try {
    const { del } = require("@vercel/blob");
    await del(pathname);
  } catch (err) { /* best-effort only - the tombstone above is authoritative */ }
  return blob;
}

module.exports = {
  getCurrentAwards, saveAwards, setAwardSlot, CURRENT_PATHNAME,
  getActivationDates, getActivationDate, setActivationDate, ACTIVATION_PREFIX, activationPathname,
};
