# Standalone consolidation server

Fixes the recurring OOM crashes on `/api/province-upload` by moving KPI consolidation off Vercel's
memory-capped serverless functions and onto a normal, always-on process with as much RAM as it
actually needs. It reuses `lib/consolidate.js` and `lib/kpiStore.js` completely unchanged - this
process has no KPI logic of its own, so it can never compute a different figure than the one already
covered by this repo's test suite.

## How it fits together

```
Admin uploads a file
        |
        v
Vercel function (api/province-upload.js)   <-- unchanged: validates the file, stores it in
        |                                       Blob, still runs inside Vercel                                  
        | HTTP POST /consolidate
        v
Consolidation server (this folder)         <-- NEW: reads every province from Blob, runs the
        |                                       full KPI pipeline, publishes the result - all
        v                                       on a host with a real memory budget
   Blob storage (ntp-kpi/current.json)
```

The Vercel function still does the fast, cheap parts (auth, file validation, storing the raw
upload) locally, exactly as before. Only the heavy part - reading every province's data and
recomputing the region - moved to this server. The (potentially large) consolidated KPI JSON is
published to Blob directly from here; it never has to pass back through the Vercel function's memory.

## Deploying to Railway

1. Push this repository to a git provider Railway can read (GitHub, GitLab).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Railway auto-detects Node via `package.json` and will run `npm run build` (regenerates
   `lib/assets.generated.js`) then `npm start` (`node server/index.js`) automatically - no extra
   config needed.
4. Set these environment variables on the Railway service (Settings → Variables):
   - `BLOB_READ_WRITE_TOKEN` - a **static** Vercel Blob read-write token for the same Blob store
     this project already uses. This project runs on Vercel's OIDC auth normally, which only works
     inside Vercel's own runtime - Railway needs the older static token instead. Get it from the
     Vercel dashboard → the project → Storage → the Blob store → Connections/tokens. (Vercel's UI
     may suggest revoking this token since "no connected project uses it" - don't: it's about to be
     used by this server instead.)
   - `CONSOLIDATION_SERVER_TOKEN` - any long random string you generate yourself (e.g.
     `openssl rand -hex 32`). This is the shared secret the Vercel side uses to authenticate to this
     server - anyone with it can trigger a full re-consolidation, so treat it like a password.
   - `PORT` - Railway sets this automatically; no action needed.
5. Once deployed, Railway gives you a public URL like `https://your-service.up.railway.app`. Note it.
6. Check `GET https://your-service.up.railway.app/health` returns `{"ok":true}`.

## Wiring Vercel to use it

On the Vercel project (Settings → Environment Variables), add:
- `CONSOLIDATION_SERVER_URL` - the Railway URL from step 5 above.
- `CONSOLIDATION_SERVER_TOKEN` - the exact same value you set on Railway in step 4.

Redeploy the Vercel project after adding these (env var changes require a redeploy to take effect).
Once both are set, `lib/consolidationClient.js` on the Vercel side will route every upload/delete's
consolidation step to this server instead of running it in-process.

## If the server is ever unreachable

Uploads will still validate and save the raw file (that part never left Vercel), but the "re-
consolidate and publish" step will fail with a clear "Consolidation server unreachable" error, and
the upload handler's existing rollback logic will restore the province slot to what it held before -
exactly the same safe failure behavior as a genuine consolidation error today. Nothing gets silently
corrupted; the admin just sees an error and can retry once the server is back.
