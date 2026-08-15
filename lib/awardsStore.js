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

// Single global activation date/time for the whole Awardee & Recognition module (System Scheduling
// requirement: admin inputs one date, the module activates - i.e. starts showing real standings
// instead of a "Coming Soon" placeholder - at that date/time). Stored separately from the awards
// board itself (a different lifecycle: set rarely, read on every dashboard load) so reading/writing
// one never risks corrupting the other. A missing value means "not yet configured" - the module
// behaves exactly as it did before this feature existed (always visible), not hidden by default.
const ACTIVATION_PATHNAME = "ntp-awards/activation.json";

/** @returns {Promise<string|null>} the stored activation date/time as an ISO-ish string, or null. */
async function getActivationDate() {
  if (blobConfigured()) {
    try {
      const { get } = require("@vercel/blob");
      const result = await get(ACTIVATION_PATHNAME, { access: "private" });
      if (result && result.statusCode === 200 && result.stream) {
        const text = await new Response(result.stream).text();
        const parsed = JSON.parse(text);
        return (parsed && typeof parsed.activatesAt === "string" && parsed.activatesAt) ? parsed.activatesAt : null;
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/not\s*found|404|no such/i.test(msg)) {
        console.error("awardsStore.getActivationDate: Blob read failed:", err);
      }
    }
  }
  return null;
}

/**
 * Sets (or, given a falsy value, clears) the activation date/time.
 * @param {string|null} iso - a datetime-local value (e.g. "2026-09-01T08:00") or null to clear.
 */
async function setActivationDate(iso) {
  if (!blobConfigured()) {
    throw new Error(
      "No Blob store connected (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set). " +
        "Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) " +
        "so the activation date can persist."
    );
  }
  const { put } = require("@vercel/blob");
  const value = (iso && String(iso).trim()) ? String(iso).trim() : null;
  const blob = await put(ACTIVATION_PATHNAME, JSON.stringify({ activatesAt: value }), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return blob;
}

module.exports = {
  getCurrentAwards, saveAwards, setAwardSlot, CURRENT_PATHNAME,
  getActivationDate, setActivationDate, ACTIVATION_PATHNAME,
};
