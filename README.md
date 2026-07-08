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

## Known limitations

- **Cache is browser-local.** IndexedDB lives in this browser profile; switching browser or device requires a rescan.
- **Full rescan each time.** Scans reuse the local store, but each scan re-walks the drive (delta-based incremental scan is a future improvement).
- **Hashes may be missing** for some files (e.g. certain vault/special items). Those files are skipped by duplicate detection rather than guessed.
- **Similar-image detection is a future phase.** The architecture is ready (`imageHashWorker.ts`, `perceptualHash.ts`, `similarityScore.ts` implement dHash + hamming distance) but it is not wired into the UI; similar images will only ever be flagged as *suspicious* and require manual review.
- **Keep the tab open** during a scan or delete run — workers stop when the tab closes (state is persisted, so you can simply rerun).
- Personal OneDrive returns SHA-1/SHA-256 hashes; OneDrive for Business returns QuickXor. Both are supported.
