const crypto = require("crypto");
const { blobConfigured } = require("./kpiStore");

const COOKIE = "ntp_visitor";
const DAYS = 30;
const PREFIX = "ntp-traffic/v1/";

function namespace() {
  // Never mix preview/test traffic with the live report.
  return PREFIX + (process.env.VERCEL_ENV || "development") + "/";
}

function phDay(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function recordVisit(visitor, now = new Date()) {
  if (!blobConfigured()) throw new Error("Visitor storage is not connected.");
  const { put } = require("@vercel/blob");
  // Immutable events avoid lost increments on simultaneous serverless requests. No IP, URL,
  // referrer, account identity or user agent is stored. Only the hash of a random browser ID.
  const hash = crypto.createHash("sha256").update(visitor).digest("hex");
  const path = namespace() + phDay(now) + "/" + hash + "/" + crypto.randomUUID() + ".json";
  await put(path, "{}", { access: "private", addRandomSuffix: false, contentType: "application/json" });
}

async function getReport(now = new Date()) {
  if (!blobConfigured()) throw new Error("Visitor storage is not connected.");
  const { list } = require("@vercel/blob");
  const days = Array.from({ length: DAYS }, (_, i) => phDay(new Date(now.getTime() - i * 86400000)));
  const unique = new Set();
  const daily = [];
  let total = 0;
  // Read only the selected days, paginating every result. Sequential reads bound concurrency.
  for (const date of days) {
    const prefix = namespace() + date + "/";
    const visitors = new Set();
    let views = 0, cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        const match = blob.pathname.slice(prefix.length).match(/^([a-f0-9]{64})\/[a-f0-9-]+\.json$/);
        if (!match) continue;
        visitors.add(match[1]);
        unique.add(match[1]);
        views++;
        total++;
        // Return an honest unavailable state rather than truncated, misleading totals.
        if (total > 50000) throw new Error("Report exceeds the supported traffic volume.");
      }
      cursor = page.hasMore ? page.cursor : undefined;
      if (page.hasMore && !cursor) throw new Error("Incomplete visitor report.");
    } while (cursor);
    daily.push({ date, views, visitors: visitors.size });
  }
  return { days: DAYS, timeZone: "Asia/Manila", environment: process.env.VERCEL_ENV || "development",
    from: days[DAYS - 1], to: days[0], views: total, visitors: unique.size, daily };
}

function withVisitorTracking(html) {
  // Browser-only collection avoids counting ordinary crawlers, HEAD requests and asset requests.
  // Failures must never prevent the public dashboard from rendering.
  const script = `<script>
(function () {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  fetch('/api/traffic', { method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});
})();
</script>`;
  return html.replace("</body>", script + "\n</body>");
}

module.exports = { COOKIE, DAYS, phDay, recordVisit, getReport, withVisitorTracking };
