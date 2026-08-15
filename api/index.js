// Public dashboard - GET /. Renders the full self-contained dashboard document (same template/JS
// as the desktop version) from the consolidated provincial uploads. No auth required - this page is
// intentionally public; only /admin is gated.
//
// There is no bundled dataset to fall back on: every figure shown here is computed from provincial
// files that have actually been uploaded. Until the first one arrives there is genuinely nothing to
// report, so this serves a plain "awaiting uploads" page naming the outstanding areas rather than an
// empty dashboard that looks broken - or, worse, stale numbers presented as if they were current.
const { getCurrentKpi } = require("../lib/kpiStore");
const { getCurrentAwards, getActivationDates } = require("../lib/awardsStore");
const { buildDashboardHtml } = require("../lib/buildDashboardHtml");
const { PROVINCE_SLOTS } = require("../lib/provinceTemplate");
const { getAllProvinceEntries, blobConfigured } = require("../lib/provinceStore");

function awaitingUploadsHtml(outstanding, storageMissing) {
  const list = outstanding.length
    ? `<ul>${outstanding.map((s) => `<li>${s.label}</li>`).join("")}</ul>`
    : "<p>All areas have submitted - the regional view is being rebuilt. Refresh in a moment.</p>";
  const note = storageMissing
    ? `<p class="warn">No storage is connected for this deployment, so uploads cannot be saved yet.
       Connect a Vercel Blob store in the project's Storage tab.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NTP Bicol Region Dashboard</title>
<style>
  :root{ --navy:#0b2a4a; --teal:#0f7d8c; --border:#dfe5ea; --muted:#647486; }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
    background:#f4f6f8;color:#1f2d3a;display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:24px;}
  .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:36px 40px;
    max-width:560px;box-shadow:0 10px 40px rgba(11,42,74,.06);}
  h1{margin:0 0 6px;font-size:20px;color:var(--navy);}
  .sub{color:var(--teal);font-size:13px;font-weight:700;margin-bottom:20px;}
  p{font-size:13.5px;line-height:1.65;color:#374a5c;}
  ul{font-size:13.5px;line-height:1.9;color:var(--navy);margin:10px 0 18px;padding-left:20px;}
  .warn{background:#fdf2e2;color:#8a6300;border-radius:8px;padding:11px 13px;font-size:12.5px;}
  a{color:var(--teal);font-weight:700;text-decoration:none;}
  a:hover{text-decoration:underline;}
  .foot{margin-top:22px;padding-top:16px;border-top:1px dashed var(--border);
    font-size:12px;color:var(--muted);}
</style>
</head>
<body>
  <div class="card">
    <h1>NTP Bicol Region Dashboard</h1>
    <div class="sub">Awaiting provincial data</div>
    <p>Every figure on this dashboard is computed from the data files submitted by each province and
       city. None have been uploaded yet, so there is nothing to report.</p>
    <p><b>Still to submit:</b></p>
    ${list}
    ${note}
    <div class="foot">Administrators can upload files on the <a href="/admin">admin page</a>.
      The dashboard appears automatically once the first file is submitted.</div>
  </div>
</body>
</html>
`;
}

// Shown only for a GENUINE failure (storage outage, an unexpected exception, etc.) - distinct from
// "no data uploaded yet", which is the normal, expected awaitingUploadsHtml() page above. The public
// site must never show a bare, unbranded error response: a visitor sees the same look-and-feel either
// way, just with an honest explanation instead of a stack trace. The underlying message is still
// included (not swallowed) so an admin looking at it can diagnose the real cause.
function errorPageHtml(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NTP Bicol Region Dashboard</title>
<style>
  :root{ --navy:#0b2a4a; --teal:#0f7d8c; --border:#dfe5ea; --muted:#647486; --red:#c0392b; }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
    background:#f4f6f8;color:#1f2d3a;display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:24px;}
  .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:36px 40px;
    max-width:560px;box-shadow:0 10px 40px rgba(11,42,74,.06);}
  h1{margin:0 0 6px;font-size:20px;color:var(--navy);}
  .sub{color:var(--red);font-size:13px;font-weight:700;margin-bottom:20px;}
  p{font-size:13.5px;line-height:1.65;color:#374a5c;}
  .detail{background:#fbe9e7;color:var(--red);border-radius:8px;padding:11px 13px;font-size:12.5px;
    font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-word;}
  .foot{margin-top:22px;padding-top:16px;border-top:1px dashed var(--border);
    font-size:12px;color:var(--muted);}
</style>
</head>
<body>
  <div class="card">
    <h1>NTP Bicol Region Dashboard</h1>
    <div class="sub">Temporarily unavailable</div>
    <p>The dashboard could not be loaded right now. This is not a data problem - it will come back once
       the underlying issue is resolved. Try refreshing in a moment.</p>
    <p class="detail">${String(message || "Unknown error").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
    <div class="foot">If this persists, contact the dashboard administrator.</div>
  </div>
</body>
</html>
`;
}

module.exports = async (req, res) => {
  try {
    const { kpi } = await getCurrentKpi();

    if (!kpi) {
      let outstanding = PROVINCE_SLOTS.slice();
      if (blobConfigured()) {
        try {
          const entries = await getAllProvinceEntries();
          outstanding = PROVINCE_SLOTS.filter((s) => !entries[s.id]);
        } catch (e) { /* fall back to listing every area */ }
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(awaitingUploadsHtml(outstanding, !blobConfigured()));
      return;
    }

    const [{ awards }, activation] = await Promise.all([getCurrentAwards(), getActivationDates()]);
    const html = buildDashboardHtml(kpi, awards, activation);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (err) {
    console.error("GET / failed:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(500).send(errorPageHtml(err && err.message));
  }
};
