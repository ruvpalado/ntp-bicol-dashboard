// GET  /api/awards
//        -> { awards, updatedAt, source, activation }. Public - the standings this returns are
//           already visible on the live public dashboard (see vendor/dashboard_js_full.txt's
//           renderAwards()), so there is nothing extra to protect by gating reads. `activation` is
//           { "<AREA>": "<datetime-local value>" } for every area that has one configured - an area
//           absent from it has never been configured (always visible, see isAreaActivated()).
// GET  /api/awards?candidates=1&category=cnr&scope=region|province&province=ALBAY
//        -> { candidates: [{key,name,value}, ...] } ranked highest-first, for the admin panel's
//           override picklist. Also public, for the same reason as above.
// POST /api/awards  { period, scope, province, category, level, awardee }
//        -> { ok: true }. Sets (or, if awardee is null, clears) one Gold/Silver/Bronze slot.
//           Requires an authenticated admin session - this is the only mutating action here.
// POST /api/awards  { setActivation: { area: "<AREA>", value: "<datetime-local value>"|null } }
//        -> { ok: true, activation }. System Scheduling: sets (or, given a null value, clears) ONE
//           area's activation date/time (e.g. that province's own DQC commencement) - before it,
//           that area's Awardee Recognition page shows a "Coming Soon" placeholder instead of live
//           standings; the Region-wide board activates once every area has activated (see
//           isAreaActivated()/isRegionAwardsActivated() in vendor/dashboard_js_full.txt). Also
//           requires an authenticated admin session.
const { isAuthenticated } = require("../lib/auth");
const { readRawBody, query } = require("../lib/httpUtil");
const { getCurrentAwards, setAwardSlot, getActivationDates, setActivationDate } = require("../lib/awardsStore");
const { candidatesFor } = require("../lib/awardRanking");
const { getCurrentKpi } = require("../lib/kpiStore");
const { PROVINCE_SLOTS } = require("../lib/provinceTemplate");
const VALID_AREAS = new Set(PROVINCE_SLOTS.map((s) => s.id));

async function handleGet(req, res) {
  if (query(req, "candidates") === "1") {
    const category = query(req, "category");
    const scope = query(req, "scope") || "region";
    const province = query(req, "province") || "";
    try {
      const { kpi } = await getCurrentKpi();
      const candidates = candidatesFor(kpi, category, scope, province).slice(0, 15);
      res.status(200).json({ candidates });
    } catch (err) {
      res.status(500).json({ error: (err && err.message) || "Unknown error" });
    }
    return;
  }
  try {
    const [{ awards, updatedAt, source }, activation] = await Promise.all([
      getCurrentAwards(),
      getActivationDates(),
    ]);
    res.status(200).json({ awards, updatedAt, source, activation });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || "Unknown error" });
  }
}

async function handlePost(req, res) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  try {
    const raw = await readRawBody(req);
    let body;
    try { body = JSON.parse((raw && raw.toString("utf8")) || "{}"); }
    catch (e) { res.status(400).json({ error: "Body must be valid JSON." }); return; }

    // System Scheduling: setting one area's activation date/time is a distinct action from
    // assigning a Gold/Silver/Bronze slot (below) - checked first, via a dedicated key, so it can
    // never be confused with a slot-clearing request (which also passes a falsy "awardee").
    if (Object.prototype.hasOwnProperty.call(body || {}, "setActivation")) {
      const payload = body.setActivation;
      const area = payload && String(payload.area || "").trim().toUpperCase();
      if (!payload || !area) {
        res.status(400).json({ error: "setActivation requires an area." });
        return;
      }
      if (!VALID_AREAS.has(area)) {
        res.status(400).json({ error: `Unknown area "${area}".` });
        return;
      }
      await setActivationDate(area, payload.value || null);
      const activation = await getActivationDates();
      res.status(200).json({ ok: true, activation });
      return;
    }

    const { period, scope, province, category, level, awardee } = body || {};
    if (!period || !String(period).trim()) {
      res.status(400).json({ error: "A recognition period (year) is required." });
      return;
    }
    if (scope !== "region" && scope !== "province") {
      res.status(400).json({ error: 'Scope must be "region" or "province".' });
      return;
    }
    if (scope === "province" && !province) {
      res.status(400).json({ error: 'A province is required when scope is "province".' });
      return;
    }
    if (!category) {
      res.status(400).json({ error: "A category is required." });
      return;
    }
    if (!["gold", "silver", "bronze"].includes(level)) {
      res.status(400).json({ error: 'Level must be "gold", "silver", or "bronze".' });
      return;
    }
    await setAwardSlot({
      period: String(period).trim(), scope, province, category, level,
      awardee: awardee || null,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err && err.message) || "Unknown error" });
  }
}

async function handler(req, res) {
  if (req.method === "GET") { await handleGet(req, res); return; }
  if (req.method === "POST") { await handlePost(req, res); return; }
  res.status(405).json({ error: "Method not allowed" });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
