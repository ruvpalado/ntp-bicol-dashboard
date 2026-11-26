# NTP Bicol Region Dashboard — Live Website

The dashboard is public at `/`, and `/admin` is a password-gated page with one upload slot per
province and city. Uploading a file rebuilds the regional view for everyone immediately — no
redeploy needed.

## Single source of truth

Every figure on this site is computed from the provincial files that have actually been uploaded.
There is no bundled dataset and no whole-region upload path:

- Each of the **7 areas** (Albay, Camarines Norte, Camarines Sur, Catanduanes, Masbate, Sorsogon,
  Naga City) has its own slot holding one file at a time, stored separately so uploading one area
  cannot affect another.
- On every upload the server merges the raw rows from all uploaded areas and re-runs the KPI
  pipeline over the combined workbook. Regional rates therefore come from summed numerators over
  summed denominators — not from averaging province percentages, which would be wrong.
- Region-wide reference sheets (`POPULATION`, `POPULATION CATCHMENT`, `Facility List `) are never
  concatenated — every area's file carries the same region-wide block, so appending them would
  repeat the region's population once per uploading province. Exactly one copy is used, chosen in
  this order:
  1. the dedicated **Regional Reference Data** upload for that sheet, if one exists;
  2. otherwise the first province file, in slot order, that supplies it.

  Whichever source won is recorded in the consolidation notes, so the provenance of the denominators
  is always visible.
- Until the first file is uploaded, `/` shows an "awaiting provincial data" page listing the
  outstanding areas rather than stale or placeholder numbers.

Uploaded files must follow **Format.xlsx**. Download a matching template from the admin page
(*Download the upload template*).

### Regional Reference Data

Population and the facility list describe the region, not any one area, so the admin page has two
dedicated slots for them side by side. Uploading to a slot makes that file authoritative — it is used
for every area and the copies inside the provincial workbooks are ignored. Delete it and the sheet
falls back to whichever provincial file supplies it. The Population slot reads both `POPULATION` and
`POPULATION CATCHMENT` from the same workbook, whichever are present.

## What's in this folder

- `api/index.js` — public dashboard (`/`), including the awaiting-uploads empty state
- `api/login.js` — login form + password check (`/login`)
- `api/admin.js` — password-gated page: 7 area slots, 2 regional reference slots, upload history,
  awardee recognition
- `api/province-upload.js` — receives one area's file, validates it, stores it, re-consolidates
- `api/reference-upload.js` — receives a region-wide Population or Facility List file (upload/delete)
- `api/province-data.js` — slot status (areas + reference), upload history, template download, delete
- `api/awards.js` — awardee recognition (reads public, writes admin-only)
- `api/logout.js` — clears the session (`/logout`)
- `lib/` — auth (signed cookie sessions), province template + validation, per-area Blob storage,
  the consolidation ETL, and the KPI pipeline wrapper
- `vendor/` — the same dashboard template + rendering JS + KPI pipeline as the desktop version
- `vercel.json` — routes `/`, `/login`, `/admin`, `/logout`, `/signup`, `/forgot-password`,
  `/reset-password` to their handlers

## MN outcome years

In the MN module, **2026 MN** is the outcome pie for rows in `MN 2026` whose
**Date of Diagnosis** is in 2026. **MN 2025** is the outcome-count table for
`Type = MN` rows in `TSR COHORT` whose **Date of Notification** is in 2025.
Both follow the selected province, facility, and month/quarter; unknown dates are
excluded from these year-specific panels. Missing outcomes count as **Not Recorded**.
The existing TSR KPI and other MN metrics keep their existing definitions.

Saved KPI datasets published before the year-specific pie was added must be
recomputed: after deploying, re-upload an existing provincial workbook through
`/admin` to reconsolidate all saved areas with the updated pipeline. Until then,
the pie shows a refresh notice rather than labeling an all-year total as 2026.

## Bicol NTP Network

Below Awardee Recognition, **Bicol NTP Network** provides two empty submodules:
**NTP Network** and **Request Facility Data**. These are placeholders only: no directory is
loaded, no old data is restored, and request submissions are not enabled.

## Retired NTP Network

The former data-backed NTP Network is no longer available in the public dashboard or admin reference uploads.
Its former coordinator endpoints return HTTP 410 and cannot read or create records.
Legacy `meta.ntp_network` directory data is excluded when rendering saved KPI snapshots.
This code change does not erase existing Blob objects; permanent storage cleanup is a separate
operation limited to the retired directory and coordinator records, never the province, population,
facility-list, KPI, account, awards or visitor datasets.

Run `node test_coordinator_workflow.js` to check the retired routes and directory exclusion.

## Admin-only dashboard visitors

In `/admin`, choose **Dashboard Visitors**, then **Load / refresh report**. The report shows
page views, estimated unique browsers and a daily breakdown for the last 30 calendar days,
including today, in Philippine time. Counting starts only after this feature is deployed;
there is no historical backfill. Zero means no recorded views, not proof that nobody visited.

The public dashboard sends one same-origin request to `/api/traffic` per page load. Successful
collection sets an HttpOnly, SameSite cookie containing a random browser identifier, renewed
for 30 days. Clearing cookies or using multiple browsers/devices changes the unique estimate.
Signed-in administrators, known bots, Do Not Track and Global Privacy Control are excluded;
blocked scripts, failed collection and other bots can affect accuracy. This is not an audited
count of individual people or concurrent users.

The existing connected **private** Blob store persists immutable events (no new service or secret).
It stores only a date, hashed random browser identifier and event UUID; no IP addresses, account
identities, page content or referrers. The read endpoint requires the same signed session as
`/admin`, returns only aggregate counts and sends `private, no-store`. Public callers cannot read
the report. Preview, production and local-development events are kept in separate namespaces.

Each view uses a small Blob write; loading a report lists the selected 30 daily prefixes with
pagination. Reports exceeding 50,000 views fail explicitly rather than silently undercounting.
This is intended for a modest-traffic dashboard; storage operations incur the store's normal usage.
The 30-day window is a reporting window, not an automatic deletion policy: older private event
files remain until removed through storage management. Storage failures leave the public dashboard
usable and show an unavailable state (not fabricated zeros) in the admin report.

Run `node test_visitor_analytics.js` for collection, authentication, pagination/concurrency,
Philippine-day boundaries and the admin browser-script regression checks.

## One-time deployment steps

1. **Install the Vercel CLI** (if you don't have it): `npm install -g vercel`
2. **From this folder**, run:
   ```bash
   cd "ntp-live-dashboard"
   npm install
   vercel login
   vercel link          # creates/links a new Vercel project — accept the defaults
   ```
3. **Set the required environment variables**:
   ```bash
   vercel env add ADMIN_PASSWORD
   vercel env add SESSION_SECRET
   ```
   Choose "All Environments" (or at least Production) when prompted. Without `SESSION_SECRET` the
   login page will tell you it is missing rather than failing silently. For the email vars, see
   `node scripts/setup-email-env.js` for a guided checklist.
   - `ADMIN_PASSWORD` is the shared master password - it always works and is what lets you approve
     the very first individual account (see Access model below). Without it (or any active account)
     you cannot sign in to `/admin` at all.

   **Outbound email — pick ONE sender.**
   - **Brevo (recommended — works from any server IP, no domain needed):**
     ```bash
     vercel env add BREVO_API_KEY     # from app.brevo.com/settings/keys/api (free: 300 emails/day)
     vercel env add MAIL_FROM         # e.g. "NTP Bicol Dashboard <ruvpalado@gmail.com>"
     ```
     Verify that sender once in Brevo (Settings → Senders → click the confirmation email). Because
     it's an HTTP API call, it is not subject to the SMTP IP blocks that Gmail applies to cloud
     servers — so it works reliably from Vercel.
   - **SMTP / Gmail App Password:**
     ```bash
     vercel env add SMTP_USER      # e.g. ruvpalado@gmail.com
     vercel env add SMTP_PASS      # a 16-char Google App Password (requires 2-Step Verification)
     vercel env add MAIL_FROM      # e.g. "NTP Bicol Dashboard <ruvpalado@gmail.com>"
     ```
     NOTE: Gmail frequently returns `535` for App Password SMTP from shared/datacenter IPs (like
     Vercel's), so prefer Brevo for production.
   - **Resend (needs a verified domain):**
     ```bash
     vercel env add RESEND_API_KEY
     vercel env add MAIL_FROM
     ```
     Resend requires a domain verified in their dashboard, or the shared test sender
     (`onboarding@resend.dev`) which only delivers to your own verified address.
4. **Connect a Blob store** — this is required, not optional: it is where the uploaded provincial
   files, the consolidated results, and individual accounts are stored.
   - Open the project on vercel.com → **Storage** tab → **Create Database** → **Blob** → connect it.
   - This adds the Blob credentials automatically; you don't set those yourself.
5. **Deploy**:
   ```bash
   vercel deploy --prod
   ```
6. Visit the URL Vercel gives you. It will show the awaiting-uploads page until you sign in at
   `/admin` and upload the first provincial file.

## Access model

- `/` — public, no login, viewable by anyone with the link.
- `/admin`, `/api/province-upload`, `/api/province-data` — require a signed-in session (a signed,
  httpOnly cookie, 12-hour expiry). Two ways to get one:
  - **The shared master password** (`ADMIN_PASSWORD`) — sign in at `/login` with just the password,
    no email needed. Always works, independent of the accounts below. This is what you use to
    approve the very first individual account, so there's no chicken-and-egg problem.
  - **An individual account** — request one at `/signup` (Name, Surname, Contact Number, Email
    Address). This emails a link to set a password; after that, the account sits in "Pending
    Approval" on the admin page's Team Accounts card until an admin (signed in via the master
    password or another active account) approves it. `/forgot-password` resets a forgotten password
    the same way, by email.
- `GET /api/awards` is public (the standings it returns are already shown on the public dashboard);
  writes to it require a signed-in session.
- `/api/users` (list/approve/reject/revoke accounts) requires a signed-in session.

## Notes

- Accepted upload formats: `.xlsx`, `.xls`, `.csv`, `.json`. Uploads are subject to Vercel's default
  4.5 MB request body limit.
- Every upload is recorded in the history log on the admin page: which area, who uploaded it, when,
  and whether it succeeded.
- A file is only stored after it passes validation, and the live dataset is only replaced after
  consolidation succeeds — if consolidation fails, the slot is rolled back and the previous
  dashboard stays up.
- The standalone `ntp_dashboard_v4.html` in the parent folder remains a self-contained offline copy
  with its own in-browser upload.

## Updating an existing six-month dataset

After deploying the full-year period-filter fix, sign in at `/admin` and re-upload one area's
**current, unchanged** provincial workbook to its matching upload slot. The normal upload path
rebuilds the published KPI from all stored province and reference files using the new pipeline.
Keep the existing files in the other slots; do not delete or replace them with empty templates.
A redeploy alone does not recalculate `ntp-kpi/current.json`, so its old July–December slices will
remain empty until this rebuild. Verify the 3rd/4th Quarter selections against the source workbook.
The TPT Monthly Average now divides the reporting total by the full 12-month calendar rather than
the old fixed six-month window; it is not an elapsed-month or selected-quarter average.

## Shared-name facilities in municipality CNR

Bato RHU (Catanduanes / Camarines Sur) and San Fernando RHU (Camarines Sur / Masbate)
share facility names. Municipality CNR includes each facility in both provinces' geography,
but counts only the cases owned by the selected province, matching its facility page.
This applies to full totals and month/quarter slices.

Existing published totals must be rebuilt after this fix: deploy the updated pipeline to the
consolidation server as well as the dashboard, then re-upload one area's **current, unchanged**
workbook to its matching `/admin` slot. Keep the other stored files intact. Redeploying the
dashboard alone does not recompute saved KPI data.

Run `node test_bato_cnr_province_isolation.js` for synthetic shared-name cases, reversed province
majorities, period totals and the rendered Bato CNR dropdown flow.

## Running the tests

Run `node test_full_year_period_filter.js` for full-year CNR/MN/TPT/TSR/TPT Cohort period filtering,
including Q3/Q4 dropdown changes and trend chart data in the rendered dashboard.

```bash
node test_deploy_readiness.js          # cold-start, routing, auth, empty state
node test_province_upload.js           # validation, isolation, consolidation, history
node test_reference_upload.js          # Population / Facility List slots, precedence, admin UI
node test_admin_ui.js                  # renders the real admin page and clicks the buttons
node test_consolidation_equivalence.js # proves split-then-merge reproduces regional KPIs exactly
node test_aggregation_integrity.js     # region equals the sum of its provinces, exactly
```
