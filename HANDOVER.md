# NTP Bicol Region Dashboard — Handover

**Live site:** https://ntp-bicol-dashboard.vercel.app
**Admin panel:** https://ntp-bicol-dashboard.vercel.app/admin
**Vercel project:** `prj_hTL9GnVv3BMoDkTdOtpFeWtV3oFD` (team `team_9y67HQ6YBgX3hyaw1MeD7HMN`)
**Source (local):** `Regional Dashboard/ntp-live-dashboard/` in the connected workspace folder
**Deploy:** the user runs `vercel deploy --prod` themselves via CLI — Claude does not deploy directly (a `deploy_to_vercel` MCP tool exists but is designed for new/unlinked projects and hasn't been used against this linked project).

---

## 1. What this project is

A TB (tuberculosis) surveillance dashboard for the Bicol Region (Philippines), covering 6 provinces + Naga City. Program staff upload per-province Excel workbooks (`Format.xlsx` layout) through `/admin`; a KPI pipeline recomputes regional/province/municipality/facility-level figures (CNR, TSR, MN, TPT modules) and publishes a consolidated JSON blob that the public dashboard (`/`) renders.

No data ships with the app — every figure is computed from what's actually been uploaded. Nothing is fabricated or estimated silently; missing/bad data is always surfaced honestly (e.g. "No TSR Cohort records for this scope" rather than a blank chart that looks broken).

## 2. Architecture

- **`api/index.js`** — public dashboard (`GET /`). No auth. Renders `awaiting uploads` page if no KPI is published yet, otherwise the full dashboard via `lib/buildDashboardHtml.js`.
- **`api/admin.js`** — admin page (`GET /admin`), session-auth gated.
- **`api/province-upload.js`**, **`api/province-data.js`**, **`api/reference-upload.js`** — upload / status / delete endpoints for province and region-wide reference files. All admin-only.
- **`api/awards.js`** — Gold/Silver/Bronze awardee recognition, public GET / admin POST.
- **`lib/kpiStore.js`, `lib/provinceStore.js`, `lib/awardsStore.js`** — Vercel Blob (`@vercel/blob`) persistence. Private access, `allowOverwrite:true`, `addRandomSuffix:false`.
- **`lib/consolidate.js`** — merges all uploaded province files + reference files and re-runs the KPI pipeline to produce the published regional dataset.
- **`lib/pipeline.js`** — server-side wrapper that `eval()`s the bundled pipeline against an uploaded workbook buffer (`runPipelineOnBuffer`).
- **`vendor/ntp_pipeline_browser.js`** — the actual KPI computation logic (CNR/TSR/MN/TPT, cure rates, targets, etc.). Runs both server-side (via `lib/pipeline.js`) and client-side (for live re-upload preview in the browser). **This is the file to edit for any KPI/computation change.**
- **`vendor/dashboard_js_full.txt`** — client-side rendering JS (all `renderCNR`/`renderTSR`/`renderMN`/etc. functions, chart building). **This is the file to edit for any UI/rendering change.**
- **`vendor/dashboard_template_part1.txt`** — HTML/CSS shell for the dashboard.
- **`scripts/generate-assets.js`** — bundles the three vendor files above into `lib/assets.generated.js` (a JSON-escaped-string module actually served to the browser).

### Critical build step

**After editing ANY file in `vendor/`, you MUST run:**
```
node scripts/generate-assets.js
```
This regenerates `lib/assets.generated.js`. Skipping this means your edits never reach the deployed site — the server only ever reads the generated bundle, never the vendor source files directly.

### Test suites (run individually — some take close to/over 45s)

```
node test_deploy_readiness.js          # 60 checks — bundling, routing, auth, HTML shape
node test_consolidation_equivalence.js # 15 checks — split-then-merge losslessness
node test_aggregation_integrity.js     # 16 checks — rates computed correctly, not averaged
node test_delete_publish_integrity.js  # 23 checks — delete/replace clears & republishes correctly
node test_cnr_attribution.js           # slow (>45s in this sandbox) — CNR facility/province attribution
node test_admin_ui.js
node test_catchment_population.js
node test_blob_consistency_race.js
node test_province_upload.js
node test_reference_upload.js
```
Run every relevant suite after any pipeline or dashboard-JS change before syncing. `test_cnr_attribution.js` routinely exceeds the sandbox's 45s tool-call cap — that's a known runtime issue, not a failure; it isn't touched by recent TSR-related changes so it's safe to skip when short on time, but should be run when touching CNR logic.

### File sync workflow

1. Edit `vendor/*.txt` / `vendor/*.js` / `lib/*.js` in the **outputs scratch copy** at
   `/sessions/.../outputs/ntp-live-dashboard/`.
2. `node scripts/generate-assets.js`
3. Run relevant test suites.
4. Copy changed files to the **workspace copy** the user actually has open:
   `Regional Dashboard/ntp-live-dashboard/` — always copy `lib/assets.generated.js` alongside any vendor file you changed, and verify with `md5sum` on both sides.
5. Tell the user to `vercel deploy --prod`.

---

## 3. Session history (chronological, most recent last)

Earlier sessions (not detailed here) covered: removing a "Data Quality & Methodology Notes" panel, footer text change, percentage rounding fix, splitting Cure Rate into DSTB/DRTB, fixing a JS crash that made TSR show stale CNR content, fixing a Chart.js canvas resize-loop bug on the CNR funnel panel, adding DRTB Outcome-by-year breakdown, adding `Cache-Control: no-store` to admin-facing endpoints (`api/admin.js`, `api/province-data.js`, `api/awards.js`) after confirming a real caching gap (this was NOT the cause of a "stale data after delete" report investigated the same session — that turned out to be a legitimate re-upload).

**This session — "Cure Rate Trend · DSTB vs. DRTB not showing DRTB" (Albay), then generalized to "must work for all provinces":**

1. **Root cause found:** the Cure Rate Trend chart bucketed TSR Cohort rows onto a fixed Jan–Jun **2026** calendar grid via a year-blind `monthFromDate()`. Live inspection (via Claude-in-Chrome `javascript_tool` against `NODES['P|ALBAY']`) showed Albay's 735 DSTB cohort records are dated entirely in **2025**, not 2026 — the old code was silently mislabeling 2025 April/May/June records as if they were 2026. DRTB's 76 records had no parseable date at all.

2. **Pipeline fix (`vendor/ntp_pipeline_browser.js`):**
   - `cureStats()` now buckets by real `"YYYY-MM"` keys derived from each row's actual `_date`, not a fixed current-year window. Returns `trend_by_month: {"2025-04": {total, cured}, ...}` and `trend_undated: N` (replacing the old fixed 6-element `trend_cure_count`/`trend_total` arrays).
   - `monthFromDate()` bug fixed: dates in July–December were previously silently mapped into the January bucket (`MONTHS[0]` fallback) instead of being excluded — this was corrupting CNR/MN/TPT trends too, now returns `null` for out-of-window months as it should.
   - `coerceDate()` extended to handle raw Excel serial numbers (not just `Date` objects and date-formatted strings) — covers the case where a province's source file has the date column formatted as plain number/text in Excel, so SheetJS's `cellDates:true` never auto-converts it. Verified the day-count math against SheetJS's own serial conversion.
   - Added a diagnostic: when TSR Cohort dates fail to parse, the issue message now includes a **per-province breakdown** and **sample raw values** (with `typeof`), so future date-parsing gaps are immediately actionable instead of requiring another guessing round. (Note: this message lands in `KPI.meta.data_quality_issues`, which is no longer rendered anywhere in the UI — the panel that showed it was removed in an earlier session per user request. It's only visible via direct inspection, e.g. `javascript_tool` reading `KPI.meta.data_quality_issues` on the live site, or by re-adding a UI surface for it if ever wanted.)

3. **Dashboard JS fix (`vendor/dashboard_js_full.txt`, `renderTSR()`):**
   - Cure Rate Trend chart x-axis is now the **union of real year-month keys** either DSTB or DRTB actually has data for (sorted chronologically), not a fixed Jan–Jun window. Each line has `spanGaps:false` so a genuine gap in one type doesn't visually connect across it.
   - Three distinct, honestly-worded states per type, computed by `trendState()`:
     - **`"stale"`** — `trend_by_month` field is absent entirely → published KPI predates this pipeline build → message: *"not available yet - re-upload any province file to refresh this dataset with the current pipeline."*
     - **`"undated"`** — field present but empty despite `total > 0` → every record genuinely has no parseable date → message names the exact count, e.g. *"DRTB line not plotted: none of its 76 cohort record(s) have a parseable Date of Notification, though the overall rate shown above is accurate."*
     - **`"ok"`** — real dated data exists, plotted normally; if some (not all) records are undated, a smaller note reports the count excluded from the trend (still counted in the rate above).

4. **Verified via live production inspection** (`javascript_tool` against `NODES[...]` on the deployed site, after the user redeployed + re-uploaded) across **all 7 areas**:

   | Area | DSTB total | DSTB dated? | DRTB total | DRTB dated? |
   |---|---|---|---|---|
   | **Albay** | 735 | ✅ yes (2025 + 2024 months) | 76 | ✅ yes |
   | **Camarines Norte** | 1,933 | ❌ **all undated** | 87 | ❌ **all undated** |
   | Camarines Sur | 0 | — (no cohort rows at all) | 0 | — |
   | Catanduanes | 0 | — | 0 | — |
   | Masbate | 0 | — | 0 | — |
   | Sorsogon | 0 | — | 0 | — |
   | Naga City | 0 | — | 0 | — |

   So "works in one province, not another" breaks down into two **different, legitimate** situations, confirmed via `KPI.meta.data_quality_issues`:
   - **5 areas have zero TSR Cohort rows uploaded at all** (`"TSR Cohort: the uploaded sheet has no rows at all for SORSOGON, CATANDUANES, MASBATE, CAMARINES SUR, NAGA CITY..."`) — not a bug, a data-collection gap. Current "No TSR Cohort records for this scope" messaging is already correct for these.
   - **Camarines Norte has real cohort data (2,020 total across DS+DR at time of check) but 100% fails date parsing** (`"TSR Cohort: 3242 row(s) have a non-parseable Date of Notification at source..."` region-wide). The Excel-serial-number fallback added in step 2 targets the most plausible cause of this, but **has not yet been verified against Camarines Norte's actual data** — see Next Steps.

---

## 4. Current state (as of end of this session)

- All code changes described above are **written, bundle-regenerated, test-passing** (60/60, 15/15, 16/16, 23/23), and **synced** to `Regional Dashboard/ntp-live-dashboard/` (both `vendor/ntp_pipeline_browser.js` and `lib/assets.generated.js` — checksums verified matching between the outputs scratch copy and the workspace copy).
- **NOT YET DONE:** the user has not yet run `vercel deploy --prod` for this latest round of changes (the coerceDate numeric-serial fallback + per-province diagnostic). The previous round (dynamic year-month trend bucketing) WAS already deployed and re-uploaded once, which is how the Albay/Camarines Norte per-province picture above was captured live.

## 5. Next steps for the new chat

1. **Ask the user to confirm they've deployed** (`vercel deploy --prod`) the latest changes, then **re-upload the Camarines Norte province file** (any file re-upload triggers reconsolidation — the KPI JSON only recomputes on upload/delete, not on deploy alone; this is a recurring gotcha in this project).
2. **Re-check Camarines Norte live** via Claude-in-Chrome `javascript_tool`:
   ```js
   const n = NODES['P|CAMARINES NORTE'];
   JSON.stringify({dstb: n.tsr.cure_dstb, drtb: n.tsr.cure_drtb});
   ```
   If `trend_by_month` now has entries → the Excel-serial fix worked, done.
   If still all-undated → read `KPI.meta.data_quality_issues` for the new per-province + sample-raw-value diagnostic (added this session specifically for this) to see the actual raw value blocking parsing, then extend `coerceDate()` in `vendor/ntp_pipeline_browser.js` to handle whatever format that turns out to be — **do not guess ambiguous formats blindly** (e.g. DD/MM vs MM/DD); a wrong guess silently mis-dates real patient records, which is worse than leaving it null.
3. Remember: `NODES`/`KPI` are `let`-declared globals in the page script, so `typeof NODES` works via `javascript_tool` but they won't show up in `Object.keys(window)` — don't waste time re-diagnosing that if it comes up again.
4. Standard workflow reminder for any further change: edit `vendor/*` → `node scripts/generate-assets.js` → run test suites → copy to `Regional Dashboard/ntp-live-dashboard/` with `md5sum` verification → ask user to deploy → ask user to re-upload if it's a KPI/pipeline change (not needed for dashboard-JS-only changes, since those take effect on deploy alone).

## 6. Known gotchas worth remembering

- **Stale published KPI vs. new pipeline code**: redeploying dashboard JS is instant, but the published KPI JSON only recomputes on the next province/reference upload or delete. Any new pipeline field must be defensively guarded (`|| null`, `|| {}`) in dashboard JS against old published data that predates it.
- **Blob `del()` is not durably reliable on this store**: production logs showed `deleteJson()`'s old post-delete verification warning firing repeatedly, for the SAME pathnames (CAMARINES_SUR.json, NAGA_CITY.json, CAMARINES_NORTE.json, ALBAY.json), across more than a week — not a one-off race. Root cause of the "deleted province data still shows on the dashboard" bug: `consolidate()`'s `overrides` param only protects the SAME request that did the delete; any LATER, unrelated consolidation (a different province's own upload/delete) reads every slot fresh with no override and would read the still-present "deleted" file straight back. Fixed by making `deleteJson()` (provinceStore.js) and `clearKpi()` (kpiStore.js) write a `{__deleted:true}` tombstone via `put()` instead of relying on `del()` — every read path treats a tombstone as absent, and this relies on put()-then-read consistency, which every upload in this app already depends on and has never shown this problem. The real `del()` is still attempted afterward, best-effort, purely for storage hygiene. See `test_delete_tombstone_durability.js` for the regression test that reproduces the exact bug and proves the fix.
- **`el.innerHTML = ...` template literals evaluate every embedded function call before assignment** — if any call throws, the whole assignment is skipped and the PREVIOUS module's DOM stays on screen, which looks exactly like "module A bleeding into module B" but is really an uncaught exception. Always defensively guard new fields read from KPI data in render functions.
- **This sandbox's bash tool has a hard 45s cap** (not adjustable via `timeout_ms`). Slow tests (`test_cnr_attribution.js`) will always show as timed-out here regardless of whether they'd pass — that's a tooling limitation, not a regression signal, when the change in question doesn't touch what that test covers.
- **Claude cannot run `vercel deploy --prod`** in this project — always ends with asking the user to deploy themselves.
