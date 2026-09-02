const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const { getCurrentKpi, blobConfigured } = require("../lib/kpiStore");
const { AWARD_CATEGORIES } = require("../lib/awardRanking");
const { PROVINCE_SLOTS, REFERENCE_SLOTS } = require("../lib/provinceTemplate");
const { canClearHistory } = require("../lib/historyAccess");

const PROVINCE_LABELS = {
  ALBAY: "Albay", "CAMARINES NORTE": "Camarines Norte", "CAMARINES SUR": "Camarines Sur",
  CATANDUANES: "Catanduanes", MASBATE: "Masbate", SORSOGON: "Sorsogon", "NAGA CITY": "Naga City",
};

function fmtDate(iso) {
  if (!iso) return "never - no provincial files uploaded yet";
  const d = new Date(iso);
  return (
    d.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }) + " (PH time)"
  );
}

// Renders one upload slot. Server-rendered so all seven areas are visible in the page source
// immediately - previously these were built only by client-side JS after /api/province-data
// answered, so if that call failed (or the endpoint wasn't deployed yet) the page appeared to have
// just the single legacy upload box. The client script later replaces this markup with live status.
function slotSkeleton(slot) {
  return `<div class="slot empty" data-slot="${slot.id}">
    <div class="slot-head">
      <span class="slot-name">${slot.label}</span>
      <span class="pill none">No file uploaded</span>
    </div>
    <div class="slot-meta">Awaiting the data file for this area.</div>
    <div class="slot-actions">
      <input type="file" data-file-for="${slot.id}" accept=".xlsx,.xls,.csv,.json">
      <button type="button" class="btn-sm" data-upload-for="${slot.id}">Upload</button>
    </div>
  </div>`;
}

// Same server-rendered-first approach as the province slots: the two reference slots must be usable
// even if /api/province-data never answers. The client script replaces this with live status.
function referenceSlotSkeleton(slot) {
  return `<div class="slot empty" data-ref-slot="${slot.id}">
    <div class="slot-head">
      <span class="slot-name">${slot.label}</span>
      <span class="pill none">No file uploaded</span>
    </div>
    <div class="slot-meta">${slot.hint}</div>
    <div class="slot-actions">
      <input type="file" data-ref-file-for="${slot.id}" accept=".xlsx,.xls,.csv,.json">
      <button type="button" class="btn-sm" data-ref-upload-for="${slot.id}">Upload</button>
    </div>
  </div>`;
}

function adminPageHtml({ updatedAt, source, storageWarning, dataQualityIssues, provinces, categories, slots, referenceSlots, signedInAs }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin - NTP Bicol Region Dashboard</title>
<style>
  :root{ --navy:#0b2a4a; --teal:#0f7d8c; --teal-light:#e6f5f6; --red:#c0392b; --green:#2e8b57;
    --amber:#e2a336; --border:#dfe5ea; --muted:#647486; }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1f2d3a;}
  header{background:linear-gradient(135deg,var(--navy),#154569);color:#fff;padding:16px 26px;
    display:flex;align-items:center;justify-content:space-between;}
  header h1{margin:0;font-size:18px;}
  header a.view{color:#cfe0ee;font-size:12.5px;text-decoration:none;}
  header a.view:hover{text-decoration:underline;}
  .wrap{max-width:780px;margin:32px auto;padding:0 20px;}
  .card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:18px;}
  .card h2{margin:0 0 12px;font-size:14px;color:var(--navy);}
  .status-row{display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--border);}
  .status-row b{color:var(--navy);}
  input[type=file]{margin-bottom:14px;}
  button{padding:10px 20px;border:none;border-radius:8px;background:var(--teal);color:#fff;
    font-size:13px;font-weight:700;cursor:pointer;}
  button:hover{background:#0c6674;}
  button:disabled{background:#a9c6ca;cursor:not-allowed;}
  form.logout{display:inline;}
  form.logout button{background:transparent;border:1px solid #cfe0ee;color:#cfe0ee;padding:6px 12px;font-size:11.5px;}
  form.logout button:hover{background:rgba(255,255,255,.08);}
  .banner{border-radius:8px;padding:12px 14px;font-size:12.5px;margin-bottom:16px;display:none;}
  .banner.ok{background:#e5f5ec;color:var(--green);}
  .banner.err{background:#fbe9e7;color:var(--red);}
  .banner.warn{background:#fdf2e2;color:#8a6300;}
  .banner.show{display:block;}
  .field-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
  .field-row label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;
    letter-spacing:.03em;margin-bottom:5px;}
  .field-row select,.field-row input{padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:12.5px;min-width:170px;}
  .award-level-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
  .award-level-row .medal{width:64px;font-size:11px;font-weight:700;text-transform:uppercase;}
  .medal.gold{color:#a67c00;} .medal.silver{color:#5c636b;} .medal.bronze{color:#8a4b25;}
  .award-level-row select{flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:12.5px;}
  .standings-hint{font-size:11px;color:var(--muted);margin:-6px 0 14px;}
  /* Province upload slots + history log (Admin Page Upload & Consolidation spec) */
  .slot{border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;}
  .slot.empty{border-style:dashed;background:#fcfdfe;}
  .slot-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;}
  .slot-name{font-size:13px;font-weight:700;color:var(--navy);}
  .pill{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
    padding:3px 9px;border-radius:12px;}
  .pill.ok{background:#e5f5ec;color:var(--green);}
  .pill.none{background:#f1f3f5;color:var(--muted);}
  .slot-meta{font-size:11.5px;color:var(--muted);line-height:1.6;}
  .slot-actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;}
  .slot-actions input[type=file]{font-size:11.5px;margin:0;max-width:230px;}
  /* The two region-wide reference slots sit side by side; they stack on narrow screens so the
     file inputs and buttons never get squeezed to unusable widths. */
  .ref-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start;}
  .ref-grid .slot{margin-bottom:0;display:flex;flex-direction:column;height:100%;}
  .ref-grid .slot-actions{margin-top:auto;padding-top:10px;}
  .ref-grid .slot-actions input[type=file]{max-width:100%;flex:1 1 140px;min-width:0;}
  @media (max-width:640px){ .ref-grid{grid-template-columns:1fr;} }
  .btn-sm{padding:6px 12px;font-size:11.5px;}
  .btn-danger{background:var(--red);} .btn-danger:hover{background:#a5311f;}
  .btn-ghost{background:transparent;color:var(--teal);border:1px solid var(--border);}
  .btn-ghost:hover{background:var(--teal-light);}
  table.hist{width:100%;border-collapse:collapse;font-size:11.5px;}
  table.hist th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;
    letter-spacing:.03em;padding:6px 8px;border-bottom:1px solid var(--border);}
  table.hist td{padding:6px 8px;border-bottom:1px dashed var(--border);vertical-align:top;}
  table.hist tr.bad td{background:#fdf3f2;}
  .hist-status{font-weight:700;} .hist-status.ok{color:var(--green);} .hist-status.bad{color:var(--red);}
</style>
</head>
<body>
<header>
  <h1>NTP Bicol Region Dashboard &mdash; Admin</h1>
  <div style="display:flex;align-items:center;gap:14px;">
    <span class="view" style="opacity:.85;">Signed in as ${signedInAs === "master" ? "admin (shared password)" : signedInAs}</span>
    <a class="view" href="/" target="_blank">View live dashboard &rarr;</a>
    <form class="logout" method="POST" action="/logout"><button type="submit">Sign out</button></form>
  </div>
</header>
<div class="wrap">
  <div id="warnBanner" class="banner warn ${storageWarning ? "show" : ""}">${storageWarning || ""}</div>
  <div id="statusBanner" class="banner"></div>

  <div class="card">
    <h2>Current live data</h2>
    <div class="status-row"><span>Source</span><b id="sourceLabel">${source === "provincial-uploads" ? "Consolidated from provincial uploads" : "No provincial files uploaded yet"}</b></div>
    <div class="status-row"><span>Last updated</span><b id="updatedLabel">${fmtDate(updatedAt)}</b></div>
  </div>

  ${dataQualityIssues && dataQualityIssues.length ? `
  <div class="card">
    <h2>Data Quality Issues (${dataQualityIssues.length})</h2>
    <div class="standings-hint">
      Rows the pipeline could not confidently attribute to a province or municipality on the last
      consolidation - most often a facility name in an uploaded sheet (Screening Presumptive, Sputum
      Examination, Stool Base, GenXpert, Parago, etc.) that has no match in the Facility List roster
      or the built-in reference list. Those rows are excluded from that module's figures rather than
      guessed, so a province can look like it has no Laboratory/Screening data when really it just has
      an unmatched facility name somewhere in that sheet. Add the missing facility (with the exact
      spelling used in the province's file) to the Facility List and re-upload to fix.
    </div>
    <ul style="font-size:12px;color:var(--red);line-height:1.7;margin:0;padding-left:20px;">
      ${dataQualityIssues.map((m) => `<li>${String(m).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</li>`).join("")}
    </ul>
  </div>` : ""}

  <div class="card">
    <h2>Province &amp; City Data Uploads</h2>
    <div class="standings-hint">
      Each province and Naga City has its own slot holding one file at a time. Uploading replaces only
      that area's records &mdash; the other slots are untouched. After every upload the regional dashboard
      is rebuilt automatically by merging all uploaded areas and recomputing every KPI.
      <a href="/api/province-data?template=1" style="color:var(--teal);font-weight:700;">Download the upload template</a>.
    </div>
    <div id="provinceSlots">${slots.map(slotSkeleton).join("")}</div>
  </div>

  <div class="card">
    <h2>Regional Reference Data</h2>
    <div class="standings-hint">
      Region-wide data uploaded once for the whole region, not per province. Uploading here makes the
      file authoritative: it is used for every area and the copies inside the provincial workbooks are
      ignored. If a slot is empty, the sheet falls back to whichever provincial file supplies it.
      Uses the same &ldquo;Uploaded by&rdquo; name as the area uploads above.
    </div>
    <div class="ref-grid" id="referenceSlots">${referenceSlots.map(referenceSlotSkeleton).join("")}</div>
  </div>

  <div class="card">
    <h2>Awardee Recognition</h2>
    <div class="standings-hint">Gold/Silver/Bronze are identified automatically from current performance data on the public dashboard - no action is needed here for the normal case. Use this panel only to override a specific slot (e.g. a confirmed disqualification or data correction); pick "-- none --" to clear an override and return that slot to automatic identification.</div>
    <div id="awardsWarnBanner" class="banner warn"></div>

    <div class="panel" style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px;">
      <h3 style="margin:0 0 6px;font-size:13px;color:var(--navy);">Module Activation (Per Area)</h3>
      <div class="standings-hint" style="margin:0 0 10px;">
        Event-driven, per province/city: the public dashboard shows a &ldquo;Coming Soon&rdquo; placeholder for
        Awardee Recognition on an area's own page until that area's own date/time, e.g. its DQC (Data Quality
        Check) commencement - then it switches to live standings automatically for that area only. Leave an
        area empty and Save to keep it always visible (the default, and what stays in effect if you never set
        anything for it - other areas' dates never affect it). The Bicol Region view activates once every area
        below that HAS a date has passed it.
      </div>
      <div id="awActivationRows">
        ${slots.map((s) => `<div class="field-row" style="align-items:flex-end;margin-bottom:8px;" data-area="${s.id}">
          <div style="min-width:130px;font-size:12.5px;color:var(--navy);font-weight:600;">${s.label}</div>
          <div>
            <input type="datetime-local" class="awActivationInput" style="width:220px;">
          </div>
          <button type="button" class="btn-sm awActivationSaveBtn">Save</button>
          <button type="button" class="btn-sm btn-ghost awActivationClearBtn">Clear (always visible)</button>
          <div class="awActivationStatus standings-hint" style="margin:0 0 0 8px;flex:1;"></div>
        </div>`).join("")}
      </div>
    </div>

    <div class="field-row">
      <div>
        <label for="awPeriod">Recognition Period (Year)</label>
        <input type="text" id="awPeriod" value="${new Date().getFullYear()}" style="width:100px;">
      </div>
      <div>
        <label for="awScope">Ranking Level</label>
        <select id="awScope">
          <option value="region">Regional</option>
          <option value="province">Provincial</option>
        </select>
      </div>
      <div id="awProvinceWrap" style="display:none;">
        <label for="awProvince">Province</label>
        <select id="awProvince">
          ${provinces.map((p) => `<option value="${p.key}">${p.label}</option>`).join("")}
        </select>
      </div>
      <div>
        <label for="awCategory">Category</label>
        <select id="awCategory">
          ${categories.map((c) =>
            `<option value="${c.key}" data-unit="${c.provinceUnit}"${c.key === "dstb_tsr" ? " selected" : ""}>${c.label}</option>`
          ).join("")}
        </select>
      </div>
    </div>
    <div id="awardsUnitHint" class="standings-hint"></div>
    <div id="awardLevels">
      <div class="award-level-row"><span class="medal gold">Gold</span><select id="awGold"></select></div>
      <div class="award-level-row"><span class="medal silver">Silver</span><select id="awSilver"></select></div>
      <div class="award-level-row"><span class="medal bronze">Bronze</span><select id="awBronze"></select></div>
    </div>
    <div class="standings-hint" style="margin-top:14px;">Standings by <span id="awTableUnit">—</span>, ranked highest-first.</div>
    <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
      <table class="hist" style="margin:0;">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th>Success Rate</th>
            <th>Cure Rate</th>
            <th>Bacteriologically Confirmed</th>
          </tr>
        </thead>
        <tbody id="awCandidatesBody"><tr><td colspan="5" class="slot-meta">Loading standings...</td></tr></tbody>
      </table>
    </div>
    <button id="awardsSaveBtn" type="button" style="margin-top:14px;">Save Awardees</button>
    <div id="awardsStatusBanner" class="banner" style="margin-top:14px;"></div>
  </div>

  <div class="card">
    <h2>Upload History</h2>
    <div class="standings-hint">Audit log of every province and reference upload/delete action, newest first &mdash; recorded automatically, nothing to configure here.</div>
    <div id="historyBox"><div class="slot-meta">Loading upload history...</div></div>
    ${canClearHistory(signedInAs) ? `<div class="slot-actions" style="margin-top:12px;">
      <button type="button" id="clearHistoryBtn" class="btn-sm btn-danger">Clear History</button>
    </div>` : ""}
  </div>

  <div class="card">
    <h2>Team Accounts</h2>
    <div class="standings-hint">
      Accounts request access via the login page's "Create an account" link. New requests appear
      below under Pending Approval once they've set a password - approve or reject them here. Active
      accounts can be revoked at any time. The shared admin password (used to sign in right now if
      you're not using an individual account) still works regardless of anything here.
    </div>
    <div id="usersWarnBanner" class="banner warn"></div>
    <div id="usersStatusBanner" class="banner" style="margin-top:0;margin-bottom:14px;"></div>
    <div id="pendingUsersBox"></div>
    <div id="activeUsersBox" style="margin-top:14px;"></div>
  </div>
</div>
<script>
  // "Uploaded by" is no longer a free-text field - it's recorded straight off the signed-in
  // session, so the log always names the real account rather than whatever a person typed in.
  var CURRENT_USER = ${JSON.stringify(signedInAs || "master")};
  const statusBanner = document.getElementById('statusBanner');
  function showStatus(cls, msg) {
    statusBanner.className = 'banner ' + cls + ' show';
    statusBanner.textContent = msg;
  }

  // --- Awardee Recognition panel ---------------------------------------------------------------
  const awPeriod = document.getElementById('awPeriod');
  const awScope = document.getElementById('awScope');
  const awProvinceWrap = document.getElementById('awProvinceWrap');
  const awProvince = document.getElementById('awProvince');
  const awCategory = document.getElementById('awCategory');
  const awardsUnitHint = document.getElementById('awardsUnitHint');
  const awGold = document.getElementById('awGold');
  const awSilver = document.getElementById('awSilver');
  const awBronze = document.getElementById('awBronze');
  const awardsSaveBtn = document.getElementById('awardsSaveBtn');
  const awardsStatusBanner = document.getElementById('awardsStatusBanner');
  const awardsWarnBanner = document.getElementById('awardsWarnBanner');

  function awShowStatus(cls, msg) {
    awardsStatusBanner.className = 'banner ' + cls + ' show';
    awardsStatusBanner.textContent = msg;
  }

  function currentUnitLabel() {
    const opt = awCategory.options[awCategory.selectedIndex];
    return (opt && opt.getAttribute('data-unit')) || 'facility';
  }

  awScope.addEventListener('change', () => {
    awProvinceWrap.style.display = awScope.value === 'province' ? '' : 'none';
    loadAwardPanel();
  });
  awProvince.addEventListener('change', loadAwardPanel);
  awCategory.addEventListener('change', loadAwardPanel);
  awPeriod.addEventListener('change', loadAwardPanel);

  function fillLevelSelect(selectEl, candidates, current) {
    let html = '<option value="">-- none --</option>';
    let matchedCurrent = false;
    candidates.forEach((c) => {
      const isCurrent = current && current.key === c.key;
      if (isCurrent) matchedCurrent = true;
      html += '<option value="' + encodeURIComponent(JSON.stringify(c)) + '"' + (isCurrent ? ' selected' : '') + '>'
        + c.name + ' (' + c.value + ')</option>';
    });
    // If the currently-assigned awardee isn't in the top-15 shortlist (e.g. an older assignment
    // whose figures have since changed), still show it as a selected option so Save doesn't silently
    // clear it.
    if (current && !matchedCurrent) {
      html += '<option value="' + encodeURIComponent(JSON.stringify(current)) + '" selected>'
        + current.name + ' (' + current.value + ') - previously assigned</option>';
    }
    selectEl.innerHTML = html;
  }

  // Renders the standings table with Success Rate, Cure Rate and Bacteriologically Confirmed count
  // alongside the ranking. Cure Rate and Bacteriologically Confirmed only apply to the facility-level
  // TSR categories (dstb_tsr/drtb_tsr); for other categories/scopes those columns show a dash.
  function renderCandidatesTable(candidates) {
    const unit = currentUnitLabel();
    document.getElementById('awTableUnit').textContent = '(' + unit + ')';
    const tbody = document.getElementById('awCandidatesBody');
    if (!candidates.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="slot-meta">No candidates to rank for this selection.</td></tr>';
      return;
    }
    tbody.innerHTML = candidates.map((c, i) => {
      const hasTiebreak = c.cureValue != null || (c.bactCount != null && c.bactCount !== 0);
      const cure = c.cureValue != null ? (c.cureValue.toFixed(1) + '%') : (hasTiebreak ? '—' : '—');
      const bact = c.bactCount != null ? (c.bactCount + '') : (hasTiebreak ? '—' : '—');
      return '<tr>'
        + '<td>' + (i + 1) + '</td>'
        + '<td>' + (c.name || c.key) + '</td>'
        + '<td>' + (c.value != null ? (c.value.toFixed(1) + '%') : '—') + '</td>'
        + '<td>' + cure + '</td>'
        + '<td>' + bact + '</td>'
        + '</tr>';
    }).join('');
  }

  async function loadAwardPanel() {
    const scope = awScope.value;
    const province = scope === 'province' ? awProvince.value : '';
    const category = awCategory.value;
    awardsUnitHint.textContent = scope === 'region'
      ? 'Ranks every ' + currentUnitLabel() + ' across the whole region against each other.'
      : 'Ranks the ' + currentUnitLabel() + 's within the selected province.';
    try {
      const candQuery = '/api/awards?candidates=1&category=' + encodeURIComponent(category)
        + '&scope=' + encodeURIComponent(scope) + (province ? '&province=' + encodeURIComponent(province) : '');
      const [candRes, currentRes] = await Promise.all([
        fetch(candQuery).then((r) => r.json()),
        fetch('/api/awards').then((r) => r.json()),
      ]);
      const candidates = (candRes && candRes.candidates) || [];
      const period = awPeriod.value;
      const periodData = (currentRes.awards && currentRes.awards[period]) || {};
      const board = scope === 'region' ? (periodData.region || {}) : ((periodData.provinces || {})[province] || {});
      const catBoard = board[category] || {};
      fillLevelSelect(awGold, candidates, catBoard.gold);
      fillLevelSelect(awSilver, candidates, catBoard.silver);
      fillLevelSelect(awBronze, candidates, catBoard.bronze);
      renderCandidatesTable(candidates);
    } catch (err) {
      awShowStatus('err', 'Could not load standings: ' + err.message);
    }
  }

  function parseLevelValue(selectEl) {
    if (!selectEl.value) return null;
    try { return JSON.parse(decodeURIComponent(selectEl.value)); } catch (e) { return null; }
  }

  awardsSaveBtn.addEventListener('click', async () => {
    const scope = awScope.value;
    const province = scope === 'province' ? awProvince.value : undefined;
    const category = awCategory.value;
    const period = awPeriod.value;
    if (!period) { awShowStatus('err', 'Enter a recognition period (year) first.'); return; }
    awardsSaveBtn.disabled = true;
    awShowStatus('warn', 'Saving...');
    try {
      const levels = [['gold', awGold], ['silver', awSilver], ['bronze', awBronze]];
      for (const pair of levels) {
        const level = pair[0];
        const awardee = parseLevelValue(pair[1]);
        const res = await fetch('/api/awards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period: period, scope: scope, province: province, category: category, level: level, awardee: awardee }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      }
      awShowStatus('ok', 'Awardees saved - the live dashboard now reflects this board.');
    } catch (err) {
      awShowStatus('err', 'Save failed: ' + err.message);
    } finally {
      awardsSaveBtn.disabled = false;
    }
  });

  loadAwardPanel();

  // --- Module Activation, per area (System Scheduling) -------------------------------------------
  function fmtActivationStatus(iso) {
    if (!iso) return 'Not set - always visible on the public dashboard.';
    const dt = new Date(/T\d/.test(iso) ? iso : (iso + 'T00:00:00'));
    const when = isNaN(dt.getTime()) ? iso
      : dt.toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const activationState = !isNaN(dt.getTime()) && Date.now() >= dt.getTime() ? 'already active' : 'scheduled, not yet active';
    return 'Activates ' + when + ' (' + activationState + ').';
  }

  function awRow(area) {
    const row = document.querySelector('#awActivationRows [data-area="' + area + '"]');
    return {
      row,
      input: row.querySelector('.awActivationInput'),
      saveBtn: row.querySelector('.awActivationSaveBtn'),
      clearBtn: row.querySelector('.awActivationClearBtn'),
      status: row.querySelector('.awActivationStatus'),
    };
  }

  async function loadActivation() {
    try {
      const data = await fetch('/api/awards').then((r) => r.json());
      const activation = (data && data.activation) || {};
      document.querySelectorAll('#awActivationRows [data-area]').forEach((row) => {
        const area = row.getAttribute('data-area');
        const els = awRow(area);
        const iso = activation[area] || '';
        els.input.value = iso;
        els.status.textContent = fmtActivationStatus(iso);
      });
    } catch (err) {
      document.querySelectorAll('.awActivationStatus').forEach((el) => {
        el.textContent = 'Could not load activation status: ' + err.message;
      });
    }
  }

  // Each area's own save is a single, independent request server-side (see lib/awardsStore.js -
  // every area now lives at its own blob pathname, so two areas' saves can never race or clobber
  // each other). This queue just protects against a double-click on the SAME row firing twice.
  let awSaveQueue = Promise.resolve();
  async function saveActivation(area, value) {
    const els = awRow(area);
    els.saveBtn.disabled = true;
    els.clearBtn.disabled = true;
    els.status.textContent = 'Saving...';
    const run = async () => {
      const res = await fetch('/api/awards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setActivation: { area: area, value: value || null } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      const iso = (data.activation && data.activation[area]) || '';
      els.input.value = iso;
      els.status.textContent = fmtActivationStatus(iso) + ' Saved.';
    };
    awSaveQueue = awSaveQueue.then(run, run).then(
      () => { els.saveBtn.disabled = false; els.clearBtn.disabled = false; },
      (err) => {
        els.status.textContent = 'Save failed: ' + err.message;
        els.saveBtn.disabled = false;
        els.clearBtn.disabled = false;
      }
    );
    return awSaveQueue;
  }

  document.querySelectorAll('#awActivationRows [data-area]').forEach((row) => {
    const area = row.getAttribute('data-area');
    row.querySelector('.awActivationSaveBtn').addEventListener('click', () => saveActivation(area, awRow(area).input.value));
    row.querySelector('.awActivationClearBtn').addEventListener('click', () => saveActivation(area, null));
  });

  loadActivation();

  // ---------------------------------------------------------------- Province upload slots
  // Per the Upload & Consolidation spec: one file per province/city slot, isolated datasets, a
  // regional master for shared denominators, an audit log, and auto-refresh after every change.
  var provinceSlotsEl = document.getElementById('provinceSlots');
  var referenceSlotsEl = document.getElementById('referenceSlots');
  var historyBoxEl = document.getElementById('historyBox');

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtWhen(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }
  function rowCountSummary(rc) {
    if (!rc) return '';
    var parts = [];
    for (var k in rc) { if (rc[k]) parts.push(esc(k.trim()) + ': ' + rc[k].toLocaleString()); }
    return parts.join(' &middot; ');
  }

  function slotHtml(slot) {
    var cls = slot.uploaded ? 'slot' : 'slot empty';
    var pill = slot.uploaded
      ? '<span class="pill ok">Uploaded</span>'
      : '<span class="pill none">No file uploaded</span>';
    var meta = slot.uploaded
      ? ('<div class="slot-meta">' + esc(slot.filename || '') +
         ' &middot; ' + (slot.totalRows || 0).toLocaleString() + ' rows<br>' +
         'by ' + esc(slot.uploadedBy || 'unknown') + ' on ' + esc(fmtWhen(slot.uploadedAt)) +
         (rowCountSummary(slot.rowCounts) ? '<br>' + rowCountSummary(slot.rowCounts) : '') +
         ((slot.warnings && slot.warnings.length)
            ? '<br><span style="color:#8a6300;">' + esc(slot.warnings.join(' ')) + '</span>' : '') +
         '</div>')
      // NB: no apostrophes or backslash escapes anywhere in this client script - it is emitted from
      // inside a server-side template literal, which consumes backslashes, so an escaped quote here
      // would arrive in the browser unescaped and break the whole script.
      : '<div class="slot-meta">Awaiting the data file for this area.</div>';
    var actions =
      '<div class="slot-actions">' +
      '<input type="file" data-file-for="' + esc(slot.id) + '" accept=".xlsx,.xls,.csv,.json">' +
      '<button type="button" class="btn-sm" data-upload-for="' + esc(slot.id) + '">' +
        (slot.uploaded ? 'Replace' : 'Upload') + '</button>' +
      (slot.uploaded
        ? '<button type="button" class="btn-sm btn-danger" data-delete-for="' + esc(slot.id) + '">Delete</button>'
        : '') +
      '</div>';
    return '<div class="' + cls + '">' +
      '<div class="slot-head"><span class="slot-name">' + esc(slot.label) + '</span>' + pill + '</div>' +
      meta + actions + '</div>';
  }

  // Region-wide reference slot. Same shape as a province slot, but the meta line says which sheets
  // the file actually supplied, since that is what determines whether it overrides the provincial
  // copies for that sheet.
  function refSlotHtml(slot) {
    var cls = slot.uploaded ? 'slot' : 'slot empty';
    var pill = slot.uploaded
      ? '<span class="pill ok">In use region-wide</span>'
      : '<span class="pill none">No file uploaded</span>';
    var meta = slot.uploaded
      ? ('<div class="slot-meta">' + esc(slot.filename || '') +
         ' &middot; ' + (slot.totalRows || 0).toLocaleString() + ' rows<br>' +
         'by ' + esc(slot.uploadedBy || 'unknown') + ' on ' + esc(fmtWhen(slot.uploadedAt)) +
         (rowCountSummary(slot.rowCounts) ? '<br>' + rowCountSummary(slot.rowCounts) : '') +
         ((slot.warnings && slot.warnings.length)
            ? '<br><span style="color:#8a6300;">' + esc(slot.warnings.join(' ')) + '</span>' : '') +
         '</div>')
      : '<div class="slot-meta">' + esc(slot.hint || '') +
        '<br><span style="color:#8a6300;">Currently taken from the provincial files.</span></div>';
    var actions =
      '<div class="slot-actions">' +
      '<input type="file" data-ref-file-for="' + esc(slot.id) + '" accept=".xlsx,.xls,.csv,.json">' +
      '<button type="button" class="btn-sm" data-ref-upload-for="' + esc(slot.id) + '">' +
        (slot.uploaded ? 'Replace' : 'Upload') + '</button>' +
      (slot.uploaded
        ? '<button type="button" class="btn-sm btn-danger" data-ref-delete-for="' + esc(slot.id) + '">Delete</button>'
        : '') +
      '</div>';
    return '<div class="' + cls + '">' +
      '<div class="slot-head"><span class="slot-name">' + esc(slot.label) + '</span>' + pill + '</div>' +
      meta + actions + '</div>';
  }

  // Audit log table for the Upload History card - one row per record returned by
  // /api/province-data's history array (newest first, already ordered server-side by
  // appendHistory's unshift). Empty/missing history (nothing uploaded yet, or just cleared) shows
  // the same "nothing yet" style as an empty slot rather than a bare empty table.
  function historyTableHtml(history) {
    if (!history || !history.length) {
      return '<div class="slot-meta">No upload or delete activity recorded yet.</div>';
    }
    var rows = history.map(function (h) {
      var failed = h.ok === false;
      return '<tr' + (failed ? ' class="bad"' : '') + '>' +
        '<td>' + esc(fmtWhen(h.at)) + '</td>' +
        '<td>' + esc(h.action || '') + '</td>' +
        '<td>' + esc(h.target || '') + '</td>' +
        '<td>' + esc(h.uploadedBy || 'unknown') + '</td>' +
        '<td class="hist-status ' + (failed ? 'bad' : 'ok') + '">' + (failed ? 'Failed' : 'OK') + '</td>' +
        '<td>' + esc(h.message || '') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="hist"><thead><tr><th>When</th><th>Action</th><th>Target</th><th>By</th>' +
      '<th>Status</th><th>Details</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function loadProvincePanel() {
    try {
      const res = await fetch('/api/province-data', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      provinceSlotsEl.innerHTML = data.slots.map(slotHtml).join('');
      if (referenceSlotsEl && data.referenceSlots) {
        referenceSlotsEl.innerHTML = data.referenceSlots.map(refSlotHtml).join('');
      }
      if (historyBoxEl) {
        historyBoxEl.innerHTML = historyTableHtml(data.history);
      }
      if (!data.blobConfigured) {
        showStatus('warn', 'No Blob store is connected, so province uploads cannot be saved yet.');
      }
      wireSlotButtons();
    } catch (err) {
      // Leave the server-rendered slots in place - they are still usable for uploading. Just say
      // that live status (who uploaded what, and when) could not be fetched.
      showStatus('warn', 'Upload slots are ready, but current status could not be loaded: ' + err.message);
      if (historyBoxEl) historyBoxEl.innerHTML = '<div class="slot-meta">Upload history could not be loaded.</div>';
      wireSlotButtons();
    }
  }

  // Vercel Serverless Functions reject any request body over ~4.5MB (HTTP 413) before the upload
  // endpoint's own code ever runs - a real filled-in province file routinely exceeds that. So the
  // file is split into pieces here and sent as a sequence of small requests instead of one big one:
  // each piece is POSTed with &stage=chunk&uploadId=...&index=N, then a final, bodyless
  // &stage=finalize request tells the server to reassemble them and proceed exactly as it always
  // has. See api/province-upload.js and lib/chunkedUpload.js for the server side.
  const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // comfortably under the ~4.5MB platform ceiling

  async function postChunk(url, stageParams, body) {
    const res = await fetch(url + stageParams, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body,
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function makeUploadId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  async function sendUpload(url, file, onProgress) {
    const uploadId = makeUploadId();
    const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
    for (let i = 0; i < total; i++) {
      const piece = file.slice(i * UPLOAD_CHUNK_BYTES, Math.min(file.size, (i + 1) * UPLOAD_CHUNK_BYTES));
      await postChunk(url, '&stage=chunk&uploadId=' + uploadId + '&index=' + i, piece);
      if (onProgress) onProgress(i + 1, total);
    }
    return postChunk(
      url, '&stage=finalize&uploadId=' + uploadId + '&totalChunks=' + total,
      new Blob([])
    );
  }

  function wireSlotButtons() {
    var uploadBtns = provinceSlotsEl.querySelectorAll('[data-upload-for]');
    Array.prototype.forEach.call(uploadBtns, function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-upload-for');
        var input = provinceSlotsEl.querySelector('[data-file-for="' + id + '"]');
        var who = CURRENT_USER;
        if (!input || !input.files || !input.files[0]) { showStatus('err', 'Choose a file for ' + id + ' first.'); return; }
        var file = input.files[0];
        btn.disabled = true;
        showStatus('warn', 'Uploading ' + file.name + ' for ' + id + ' and rebuilding the regional view...');
        // Stays on this page throughout: no popup, no redirect, no tab. Only the inline banner above
        // updates, on success (green) or failure (red), so the admin never loses their place on the
        // page. On failure, nothing here has changed the published dashboard - the server rejects an
        // invalid file before storing it (or rolls back if consolidation fails after a valid file was
        // stored), so the live site simply keeps showing whatever was valid before this attempt.
        try {
          var data = await sendUpload('/api/province-upload?province=' + encodeURIComponent(id) +
            '&filename=' + encodeURIComponent(file.name) + '&uploadedBy=' + encodeURIComponent(who), file,
            function (done, total) {
              if (total > 1) showStatus('warn', 'Uploading ' + file.name + ' for ' + id + ' (' + done + '/' + total + ')...');
            });
          var msg;
          if (data.notPublished) {
            // The file itself is fine and was saved - there just isn't enough uploaded yet anywhere
            // to publish a regional dashboard (e.g. no Population reference exists yet). Say that
            // plainly instead of "rebuilt from 0 area(s)", which would misreport this as a failure.
            msg = 'Upload successful — ' + id + '’s dataset has been saved, but the live dashboard has ' +
              'not been rebuilt yet: ' + data.notPublishedReason;
          } else {
            msg = 'Upload successful — ' + id + '’s dataset has been applied. Regional view rebuilt from ' +
              data.presentProvinces.length + ' area(s).';
            if (data.missingProvinces && data.missingProvinces.length) {
              msg += ' Still awaiting: ' + data.missingProvinces.join(', ') + '.';
            }
          }
          if (data.warnings && data.warnings.length) msg += ' Note: ' + data.warnings.join(' ');
          showStatus('ok', msg);
          await loadProvincePanel();
          await refreshLiveStatus();
        } catch (err) {
          showStatus('err', 'Upload failed — ' + err.message);
        } finally { btn.disabled = false; }
      });
    });

    var delBtns = provinceSlotsEl.querySelectorAll('[data-delete-for]');
    Array.prototype.forEach.call(delBtns, function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-delete-for');
        var who = CURRENT_USER;
        if (!window.confirm('Delete the uploaded file for ' + id + ' and rebuild the regional view without it?')) return;
        btn.disabled = true;
        showStatus('warn', 'Removing ' + id + ' data...');
        try {
          const res = await fetch('/api/province-data?province=' + encodeURIComponent(id) +
            '&uploadedBy=' + encodeURIComponent(who), { method: 'DELETE' });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          showStatus('ok', data.message || 'Removed.');
          await loadProvincePanel();
          await refreshLiveStatus();
        } catch (err) {
          showStatus('err', err.message);
        } finally { btn.disabled = false; }
      });
    });

    wireReferenceButtons();
  }

  function wireReferenceButtons() {
    if (!referenceSlotsEl) return;

    var upBtns = referenceSlotsEl.querySelectorAll('[data-ref-upload-for]');
    Array.prototype.forEach.call(upBtns, function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-ref-upload-for');
        var input = referenceSlotsEl.querySelector('[data-ref-file-for="' + id + '"]');
        var who = CURRENT_USER;
        if (!input || !input.files || !input.files[0]) { showStatus('err', 'Choose a file for ' + id + ' first.'); return; }
        var file = input.files[0];
        btn.disabled = true;
        showStatus('warn', 'Uploading ' + file.name + ' as region-wide ' + id + ' and rebuilding the regional view...');
        try {
          var data = await sendUpload('/api/reference-upload?slot=' + encodeURIComponent(id) +
            '&filename=' + encodeURIComponent(file.name) + '&uploadedBy=' + encodeURIComponent(who), file,
            function (done, total) {
              if (total > 1) showStatus('warn', 'Uploading ' + file.name + ' as region-wide ' + id + ' (' + done + '/' + total + ')...');
            });
          var msg;
          if (data.notPublished) {
            // Same "genuinely fine, just not enough uploaded yet anywhere" case as province uploads -
            // e.g. Facility List uploaded before Population exists. The file is saved; say so plainly.
            msg = data.target + ' has been saved, but the live dashboard has not been rebuilt yet: ' +
              data.notPublishedReason;
          } else {
            msg = data.target + ' is now used region-wide. Regional view rebuilt from ' +
              data.presentProvinces.length + ' area(s).';
          }
          if (data.warnings && data.warnings.length) msg += ' Note: ' + data.warnings.join(' ');
          showStatus('ok', msg);
          await loadProvincePanel();
          await refreshLiveStatus();
        } catch (err) {
          showStatus('err', err.message);
        } finally { btn.disabled = false; }
      });
    });

    var delBtns = referenceSlotsEl.querySelectorAll('[data-ref-delete-for]');
    Array.prototype.forEach.call(delBtns, function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-ref-delete-for');
        var who = CURRENT_USER;
        if (!window.confirm('Remove the region-wide ' + id + ' file? These sheets will fall back to whichever provincial file supplies them.')) return;
        btn.disabled = true;
        showStatus('warn', 'Removing region-wide ' + id + '...');
        try {
          const res = await fetch('/api/reference-upload?slot=' + encodeURIComponent(id) +
            '&uploadedBy=' + encodeURIComponent(who), { method: 'DELETE' });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          showStatus('ok', data.message || 'Removed.');
          await loadProvincePanel();
          await refreshLiveStatus();
        } catch (err) {
          showStatus('err', err.message);
        } finally { btn.disabled = false; }
      });
    });
  }

  // Keeps the "Current live data" card honest after a province upload changes the published dataset.
  async function refreshLiveStatus() {
    try {
      const res = await fetch('/api/province-data', { cache: 'no-store' });
      if (!res.ok) return;
      document.getElementById('sourceLabel').textContent = 'Consolidated from province uploads';
      document.getElementById('updatedLabel').textContent = new Date().toLocaleString();
    } catch (e) { /* non-fatal */ }
  }

  loadProvincePanel();

  // Wipes the recorded history entries (via a dedicated ?clearHistory=1 DELETE, distinct from the
  // per-province ?province=X delete above) without touching any province/reference slot or the
  // published dashboard - the log itself is the only thing this action removes.
  var clearHistoryBtn = document.getElementById('clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async function () {
      if (!window.confirm('Clear all recorded upload history entries? This cannot be undone.')) return;
      clearHistoryBtn.disabled = true;
      showStatus('warn', 'Clearing upload history...');
      try {
        const res = await fetch('/api/province-data?clearHistory=1', { method: 'DELETE' });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        showStatus('ok', 'Upload history cleared.');
        await loadProvincePanel();
      } catch (err) {
        showStatus('err', 'Could not clear history — ' + err.message);
      } finally { clearHistoryBtn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------- Team Accounts panel
  var pendingUsersBox = document.getElementById('pendingUsersBox');
  var activeUsersBox = document.getElementById('activeUsersBox');
  var usersStatusBanner = document.getElementById('usersStatusBanner');
  var usersWarnBanner = document.getElementById('usersWarnBanner');

  function usersShowStatus(cls, msg) {
    usersStatusBanner.className = 'banner ' + cls + ' show';
    usersStatusBanner.textContent = msg;
  }

  var STATUS_LABEL = {
    pending_setup: 'Awaiting their password setup (email link not yet used)',
    pending_approval: 'Pending Approval',
    active: 'Active',
    rejected: 'Rejected',
    revoked: 'Revoked',
  };

  function userRowHtml(u, actions) {
    return '<div class="slot">' +
      '<div class="slot-head"><span class="slot-name">' + esc(u.name) + ' ' + esc(u.surname) + '</span>' +
      '<span class="pill ' + (u.status === 'active' ? 'ok' : 'none') + '">' + esc(STATUS_LABEL[u.status] || u.status) + '</span></div>' +
      '<div class="slot-meta">' + esc(u.email) + ' &middot; ' + esc(u.contactNumber || 'no contact number on file') +
      '<br>requested ' + esc(fmtWhen(u.createdAt)) +
      (u.approvedAt ? ' &middot; approved ' + esc(fmtWhen(u.approvedAt)) + ' by ' + esc(u.approvedBy || '') : '') +
      '</div>' +
      '<div class="slot-actions">' + actions + '</div>' +
      '</div>';
  }

  async function usersAction(email, action, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    usersShowStatus('warn', 'Working...');
    try {
      var res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, action: action }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      usersShowStatus('ok', 'Done.');
      await loadUsersPanel();
    } catch (err) {
      usersShowStatus('err', err.message);
    }
  }

  async function loadUsersPanel() {
    try {
      var res = await fetch('/api/users', { cache: 'no-store' });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (!data.blobConfigured) {
        usersWarnBanner.className = 'banner warn show';
        usersWarnBanner.textContent = 'No Blob store is connected, so accounts cannot persist yet.';
      }
      var users = data.users || [];
      var pending = users.filter(function (u) { return u.status === 'pending_approval' || u.status === 'pending_setup'; });
      var active = users.filter(function (u) { return u.status === 'active'; });
      var other = users.filter(function (u) { return u.status === 'rejected' || u.status === 'revoked'; });

      pendingUsersBox.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px;">PENDING (' + pending.length + ')</div>' +
        (pending.length ? pending.map(function (u) {
          var actions = u.status === 'pending_approval'
            ? '<button type="button" class="btn-sm" data-approve="' + esc(u.email) + '">Approve</button>' +
              '<button type="button" class="btn-sm btn-danger" data-reject="' + esc(u.email) + '">Reject</button>'
            : '<span class="slot-meta">Nothing to do yet - waiting on them.</span>';
          return userRowHtml(u, actions);
        }).join('') : '<div class="slot-meta">No pending requests.</div>');

      activeUsersBox.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px;">ACTIVE (' + active.length + ')</div>' +
        (active.length ? active.map(function (u) {
          return userRowHtml(u, '<button type="button" class="btn-sm btn-danger" data-revoke="' + esc(u.email) + '">Revoke</button>');
        }).join('') : '<div class="slot-meta">No active individual accounts yet.</div>') +
        (other.length ? '<div style="font-size:12px;font-weight:700;color:var(--muted);margin:14px 0 8px;">REJECTED / REVOKED (' + other.length + ')</div>' +
          other.map(function (u) { return userRowHtml(u, ''); }).join('') : '');

      Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (btn) {
        btn.addEventListener('click', function () { usersAction(btn.getAttribute('data-approve'), 'approve'); });
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-reject]'), function (btn) {
        btn.addEventListener('click', function () { usersAction(btn.getAttribute('data-reject'), 'reject', 'Reject this account request?'); });
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-revoke]'), function (btn) {
        btn.addEventListener('click', function () { usersAction(btn.getAttribute('data-revoke'), 'revoke', 'Revoke this account? They will no longer be able to sign in.'); });
      });
    } catch (err) {
      pendingUsersBox.innerHTML = '<div class="slot-meta">Could not load accounts: ' + esc(err.message) + '</div>';
    }
  }
  loadUsersPanel();

</script>
</body>
</html>`;
}

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.writeHead(303, { Location: "/login?next=/admin" });
    res.end();
    return;
  }
  try {
    const { updatedAt, source, kpi } = await getCurrentKpi();
    const storageWarning = blobConfigured()
      ? null
      : "No Blob store is connected yet, so uploads and Awardee Recognition assignments can't persist across requests. Connect a Vercel Blob store to this project (Storage tab in the Vercel dashboard) before using this page - see the README.";
    const ops = (kpi && kpi.meta && kpi.meta.operational_provinces) || Object.keys(PROVINCE_LABELS);
    const provinces = ops.map((p) => ({ key: p, label: PROVINCE_LABELS[p] || p }));
    // Surfaces the pipeline's own facility->province attribution warnings (data_quality_issues,
    // computed by vendor/ntp_pipeline_browser.js on every consolidation) directly on the admin page.
    // Previously these were computed and returned in the kpi payload but never displayed anywhere, so
    // a province could silently show zero Laboratory/Screening data with no way for an admin to tell
    // why short of asking a developer to dig through the pipeline - this makes the exact unresolved
    // facility/province named right where uploads happen.
    const dataQualityIssues = (kpi && Array.isArray(kpi.data_quality_issues)) ? kpi.data_quality_issues : [];
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Mirrors GET / (api/index.js) - without this, a browser or intermediary could serve a stale
    // copy of the admin page (with stale slot statuses baked into the server-rendered skeleton and a
    // stale "Last updated" timestamp) on a later visit.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(adminPageHtml({
      updatedAt, source, storageWarning, dataQualityIssues, provinces,
      categories: AWARD_CATEGORIES, slots: PROVINCE_SLOTS, referenceSlots: REFERENCE_SLOTS,
      signedInAs: getSessionIdentity(req),
    }));
  } catch (err) {
    console.error("GET /admin failed:", err);
    res.status(500).send("Admin page failed to load: " + (err && err.message));
  }
};
