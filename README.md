# OneDrive Duplicate Cleaner

A production-ready, **frontend-only** web app that scans your OneDrive for duplicate photos, lets you review every match, and moves the copies you choose to the **OneDrive recycle bin** — never a permanent delete.

- **No backend.** Everything runs in your browser: MSAL Browser (OAuth 2.0 + PKCE) for sign-in, direct calls to Microsoft Graph, IndexedDB for the local cache, Web Workers for heavy lifting.
- **No uploads, no downloads.** The scan reads metadata and file hashes only. Thumbnails are loaded straight from OneDrive for preview.
- **Nothing is deleted automatically.** Every duplicate group requires manual review, every deletion requires an explicit confirmation, and at least one file always remains in each group.

## Tech stack

React 19 · Vite 6 · TypeScript (strict) · @azure/msal-browser · Microsoft Graph REST API · IndexedDB · Web Workers · react-router

---

## 1. Azure App Registration (one-time setup)

The app needs a (free) Azure App Registration so Microsoft lets it sign in and call Graph.

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. **Name:** anything, e.g. `OneDrive Duplicate Cleaner`.
3. **Supported account types:** choose
   *"Accounts in any organizational directory and personal Microsoft accounts"*
   (required if you want to sign in with a personal OneDrive account).
4. **Redirect URI:** select platform **Single-page application (SPA)** and enter:

   ```
   http://localhost:5173
   ```

   > Must be the SPA platform — the Web platform will fail with a CORS/PKCE error.

5. Click **Register** and copy the **Application (client) ID** from the overview page.

### API permissions

Under **API permissions**, make sure these **Microsoft Graph → Delegated** permissions are present (User.Read is added by default; add the rest via *Add a permission*):

| Permission        | Why                                            |
| ----------------- | ---------------------------------------------- |
| `User.Read`       | Show the signed-in account                     |
| `Files.ReadWrite` | List drive items and move duplicates to the recycle bin |
| `offline_access`  | Silent token renewal (added automatically by MSAL) |

These are delegated permissions — no admin consent needed; each user consents at first sign-in.

## 2. Configure the client id

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```
VITE_MSAL_CLIENT_ID=<your Application (client) ID>
```

## 3. Run

```bash
npm install
npm run dev
```

Open <http://localhost:5173> and sign in with your Microsoft account.

Production build: `npm run build` (output in `dist/` — any static host works; remember to add your production URL as an additional SPA redirect URI in Azure).

---

## How it works

1. **Scan** — a Web Worker walks your OneDrive folder tree via Graph (`/me/drive/.../children`, 200 items per page) and stores metadata for JPEG/PNG/WebP/HEIC/HEIF files in IndexedDB: name, path, size, `quickXorHash`/`sha1Hash`/`sha256Hash`, dimensions, dates, thumbnail URL. Progress streams to the UI; you can cancel anytime and keep partial results.
2. **Detect** — a second worker groups files with the **same size + same strong hash**:
   - confidence **100** = same size + SHA-1/SHA-256
   - confidence **95** = same size + QuickXor
   - files without any hash are **never** classified as duplicates.
3. **Review** — each group shows thumbnails, paths, sizes, resolution, dates and hash info. The app recommends a file to keep (highest resolution → larger file → sensible folder (`/Pictures`, `/Camera Roll` preferred; `duplicate/copy/download/temp` folders avoided) → oldest). You pick what to keep, mark the rest, or ignore the group.
4. **Delete** — marked files go to a queue. After a confirmation summary (count, size, full path list) the app calls Graph `DELETE /me/drive/items/{id}`, which is a **soft delete into the OneDrive recycle bin**. Job status (pending → deleting → deleted/failed) is tracked with per-file retry.

### Safety rules (enforced in code)

- No automatic, background, or permanent deletion.
- Deletion only after an explicit confirmation dialog.
- The recommended/chosen "keep" file can never be marked, queued, or deleted.
- At least one file must remain in every group (re-checked right before each API call).
- Missing hash → not a duplicate. Confidence below 95 → never shown as an exact duplicate.
- Everything you deleted is restorable from the OneDrive recycle bin (onedrive.live.com → Recycle bin).

## Project structure

```
src/
  app/                 App root + router
  features/
    auth/              MSAL config, auth provider, Connect page
    scanner/           Scan page, scanner orchestration, types
    duplicates/        Review page, grouping engine, phase-2 placeholders
    delete/            Delete queue page + delete service
    dashboard/ history/ settings/
  services/
    graph/             Graph client (retry/throttle/401 handling) + OneDrive service
    db/                IndexedDB wrapper + repositories
  workers/             scanWorker, duplicateWorker, imageHashWorker (phase 2)
  components/          layout, common, file, duplicate UI
  utils/               formatBytes, formatDate, fileScore, pathUtils
```

## Copy OneDrive to Google Drive

Open **Copy to Google Drive** in the sidebar. Connect Google, browse and select one
source folder in OneDrive and one destination folder in **My Drive**, then inspect
the source and confirm the copy. Selecting the root is supported. All regular
files and subfolders (including empty folders) are included, not just photos.
Every **new job** creates a new named copy folder under the selected destination.
**Resume existing job** reuses that same folder and skips completed files.
Existing destination files are never overwritten. Shortcuts, shared drives and
special OneDrive items are not supported in this version.

Google setup:

1. In [Google Cloud Console](https://console.cloud.google.com/), select/create a project and enable **Google Drive API**.
2. Configure **Google Auth Platform** branding/audience. For an external app in Testing, add your Google account as a test user.
3. Add `https://www.googleapis.com/auth/drive` to Data Access. The built-in browser lists existing folders throughout My Drive, so it requires the full Drive scope (a restricted scope). Public distribution requires Google's applicable OAuth verification; use Testing for personal development.
4. Create an OAuth client of type **Web application**. Add `http://localhost`, `http://localhost:5173` (and your actual production origin) under **Authorized JavaScript origins**.
5. Set `VITE_GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com` in `.env.local`, then restart/rebuild. This is a public client ID, **never a client secret**.

For unattended copying on this local machine, add
`http://localhost:5173/api/google/callback` to the same client's **Authorized redirect
URIs**, and set `GOOGLE_OAUTH_CLIENT_FILE` in `.env.local` to the downloaded Web
OAuth client JSON's absolute path (or set server-only `GOOGLE_CLIENT_SECRET`).
Never use a `VITE_` prefix for a secret. `client_secret*.json` is excluded from Git
and blocked by Vite's file server. Restart `npm run dev`, connect the same Google
account once and grant offline access, then resume the existing job.

The localhost Node broker holds the refresh token in memory and refreshes access
tokens automatically. The browser only receives short-lived access tokens; it
deduplicates renewal across parallel workers and checks that the account remains
the same. A 401 during upload renews credentials and queries the acknowledged
offset before resending. **Test Google renewal** verifies an actual refresh without
another login. This mode works with `npm run dev` at `http://localhost:5173` only;
keep that Node process and the browser running. Config restarts in the same Node
process retain sessions; stopping Node requires reconnecting. Refresh tokens are
never written to browser storage or disk. It does not transfer files in the
background after the browser is closed, nor add a backend to static hosting.

Without the local broker, Google access tokens remain in browser memory and
expiry pauses the job for manual reconnection. Revoked/expired refresh tokens
also require reconnecting. Google external apps in Testing receive refresh
tokens valid for seven days for Drive access; see
[Google refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Jobs, destination IDs and per-file upload checkpoints are committed to a separate
IndexedDB database in this browser. Reopening the page restores saved jobs. The
app allocates and saves a fixed Google file ID **before** creating anything, so a
lost creation/completion response can be reconciled without duplicate files.
On resume it asks Google for the actual received-byte offset, including when the
last local checkpoint is stale. Expired upload sessions restart only the unfinished
file using its original ID. Completed files are skipped. Resume requires the same
Microsoft and Google accounts. Chrome/Edge Web Locks prevent concurrent writers
in multiple tabs on the same origin.

**Local storage:** only metadata/checkpoints are stored, never file content. No
119GB download/cache is created. Transfers run up to three files concurrently,
each buffering one 8 MiB payload (up to 24 MiB of payloads; browser network/Blob
overhead is additional). Chunks within a file remain sequential. A failure cancels
and drains all workers before releasing the job lock; resume reconciles each file.
Folders are created in parent-first order before starting files. The table shows
active files first, followed by paused/pending rows, with completed rows last.
The progress panel shows wall-clock elapsed time, active time, downtime, average
speed and estimated remaining time/finish date. ETA uses the slower estimate from
remaining bytes and remaining file count, and waits for 15 seconds/3 completed
files of measured work. Active time includes API waits/retries; downtime means
paused, closed or awaiting reconnection. Timing is stored separately every five
seconds and on stop; closing abruptly can leave at most one heartbeat interval
unrecorded. Existing jobs start measuring active/downtime after this update;
historical elapsed time cannot be split retroactively. ETA assumes uninterrupted
transfer at the measured average speed and is not a guaranteed completion time.
Range-ignoring or oversized source responses are rejected before a full file can
be buffered. Metadata space is checked before a new job, and failed checkpoint
commits pause the job. Do not clear this site's browser data: that deletes the
resume records. Use the same browser profile and origin/port on return. Changing
devices or incognito sessions does not transfer these records.

Keep this page open while copying. Pause, navigation, closing the tab, token
expiry, or an unrecoverable error pauses transfer; completed files remain in Drive.
Transient Google/network errors use bounded retries with backoff and individual
requests have deadlines. Screen wake lock is requested while copying, but browsers
or the OS can refuse/release it: disable system sleep for long transfers. A closed
or suspended browser does not continue in the background. Changes in source size
or modification time pause the job. Files externally deleted/moved/changed after
completion are not automatically restored. This copies content and folder structure,
not permissions, version history, sharing links, or original timestamps.

Validation: `npm run test:transfer` covers persistence, pause/reconnect/resume,
lost responses, expired upload sessions, account guards, quota failures and bounded
chunks, including a simulated 119GB file resumed near its end. These tests do not
claim an actual authenticated 119GB transfer has completed.

Browser QA fixture: `tests/transfer-ui.html?case=<unique-run-name>` seeds an
isolated test account/job and intercepts all cloud requests. Run a separate Vite
process with `VITE_GOOGLE_CLIENT_ID=ui-test` on an unused port, open this fixture,
connect, resume until the simulated 401 pauses it, reload, reconnect, and resume.
Expected: the saved offset survives reload and the final count is **1 / 1**.
The fixture is outside the production entry point/build and never uses real cloud
credentials. Use a fresh `case` value for another test.

API references: [Google browser authorization](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Google resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[OneDrive browser downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

## Known limitations

- **Cache is browser-local.** IndexedDB lives in this browser profile; switching browser or device requires a rescan.
- **Full rescan each time.** Scans reuse the local store, but each scan re-walks the drive (delta-based incremental scan is a future improvement).
- **Hashes may be missing** for some files (e.g. certain vault/special items). Those files are skipped by duplicate detection rather than guessed.
- **Similar-image detection is a future phase.** The architecture is ready (`imageHashWorker.ts`, `perceptualHash.ts`, `similarityScore.ts` implement dHash + hamming distance) but it is not wired into the UI; similar images will only ever be flagged as *suspicious* and require manual review.
- **Keep the tab open** during a scan or delete run — workers stop when the tab closes (state is persisted, so you can simply rerun).
- Personal OneDrive returns SHA-1/SHA-256 hashes; OneDrive for Business returns QuickXor. Both are supported.
