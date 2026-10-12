import { COPY_CHUNK_BYTES, timedFetch, waitForRetry } from '../../features/transfer/transferNetwork';
const BASE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
export const googleConfigured = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);
interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
interface GoogleIdentity {
  accounts: { oauth2: {
    initTokenClient(options: { client_id: string; scope: string; callback(response: TokenResponse): void; error_callback(error: { type: string }): void }): { requestAccessToken(options: { prompt: string }): void };
  } };
}
declare global { interface Window { google?: GoogleIdentity } }
let loading: Promise<void> | undefined;
export function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve();
  return loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { loading = undefined; script.remove(); reject(new Error('โหลด Google login ไม่สำเร็จ ลองใหม่')); };
    document.head.appendChild(script);
  });
}
export interface GoogleSession { token: string; expiresAt: number; renew?: (force: boolean) => Promise<void> }
// Call synchronously from a click after the SDK has loaded (popup blockers).
export function connectGoogle(): Promise<GoogleSession> {
  return new Promise((resolve, reject) => {
    if (!window.google || !googleConfigured) { reject(new Error('ยังไม่ได้ตั้งค่า Google Client ID')); return; }
    window.google.accounts.oauth2.initTokenClient({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID!, scope: SCOPE,
      callback: result => {
        if (!result.access_token || !result.scope?.split(' ').includes(SCOPE)) {
          reject(new Error(result.error_description ?? result.error ?? 'ต้องอนุญาตสิทธิ์ Google Drive ก่อน')); return;
        }
        resolve({ token: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000 });
      },
      error_callback: error => reject(new Error(`Google login: ${error.type}`)),
    }).requestAccessToken({ prompt: 'select_account' });
  });
}
export interface DriveFolder { id: string; name: string }
export class GoogleAuthExpired extends Error {
  constructor() { super('Google session หมดอายุ กดเชื่อมต่อ Google ใหม่ แล้วทำต่อจากงานเดิม'); this.name = 'GoogleAuthExpired'; }
}
interface DriveFile { id: string; name: string; size?: string; mimeType: string; parents?: string[]; trashed?: boolean; appProperties?: Record<string, string> }
export interface UploadState { url?: string; bytes: number }
export class GoogleDrive {
  constructor(private session: GoogleSession, private retryDelay = 1000) {}
  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    if (Date.now() >= this.session.expiresAt - 60000 && this.session.renew) await this.session.renew(false);
    if (Date.now() >= this.session.expiresAt - 10000) throw new GoogleAuthExpired();
    return { Authorization: `Bearer ${this.session.token}`, ...extra };
  }
  private async check(response: Response): Promise<Response> {
    if (response.status === 401) throw new GoogleAuthExpired();
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `Google Drive HTTP ${response.status}`);
    }
    return response;
  }
  private async request(url: string, init: RequestInit = {}, retries = true): Promise<Response> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      let response: Response;
      try { const headers = await this.headers(init.headers as Record<string, string> | undefined); init.signal?.throwIfAborted(); response = await timedFetch(url, { ...init, headers }); }
      catch (error) {
        init.signal?.throwIfAborted();
        if (error instanceof GoogleAuthExpired || !retries || attempt >= 4) throw error;
        await waitForRetry(this.retryDelay * 2 ** attempt, init.signal ?? undefined); continue;
      }
      if (response.status === 401) {
        if (!renewed && this.session.renew) {
          renewed = true; await this.session.renew(true);
          // A resumable PUT must query the acknowledged offset before another body is sent.
          if (!retries) throw new Error('Google token renewed; reconcile upload offset');
          continue;
        }
        throw new GoogleAuthExpired();
      }
      const limited = response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(await response.clone().text());
      if (retries && attempt < 4 && (response.status >= 500 || response.status === 429 || limited)) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        await waitForRetry(Math.min(retryAfter > 0 ? retryAfter * 1000 : this.retryDelay * 2 ** attempt, 60000), init.signal ?? undefined); continue;
      }
      return response;
    }
  }
  async identity(): Promise<{ id: string; email: string }> {
    const response = await this.check(await this.request(`${BASE}/about?fields=user(emailAddress,permissionId)`));
    const data = await response.json() as { user?: { emailAddress?: string; permissionId?: string } };
    if (!data.user?.permissionId || !data.user.emailAddress) throw new Error('ตรวจสอบบัญชี Google ไม่ได้');
    return { id: data.user.permissionId, email: data.user.emailAddress };
  }
  async account(): Promise<string> {
    return (await this.identity()).email;
  }
  async folders(parent: string, signal?: AbortSignal): Promise<DriveFolder[]> {
    const folders: DriveFolder[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: `'${parent.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`, fields: 'nextPageToken,files(id,name)', pageSize: '1000', orderBy: 'name', ...(pageToken ? { pageToken } : {}) });
      const response = await this.check(await this.request(`${BASE}/files?${params}`, { signal }));
      const data = await response.json() as { files: DriveFolder[]; nextPageToken?: string };
      folders.push(...data.files); pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return folders;
  }
  async generateId(signal: AbortSignal): Promise<string> {
    const response = await this.check(await this.request(`${BASE}/files/generateIds?count=1&space=drive&type=files`, { signal }));
    const id = (await response.json() as { ids: string[] }).ids[0];
    if (!id) throw new Error('Google ไม่ส่ง ID สำหรับปลายทาง');
    return id;
  }
  private async getFile(id: string, signal: AbortSignal): Promise<DriveFile | null> {
    const response = await this.request(`${BASE}/files/${encodeURIComponent(id)}?fields=id,name,size,mimeType,parents,trashed,appProperties`, { signal });
    if (response.status === 404) return null;
    return await (await this.check(response)).json() as DriveFile;
  }
  private verify(file: DriveFile, parent: string, key: string, size?: number): void {
    if (file.trashed || !file.parents?.includes(parent) || file.appProperties?.copyKey !== key ||
        (size === undefined ? file.mimeType !== 'application/vnd.google-apps.folder' : Number(file.size) !== size)) {
      throw new Error('รายการปลายทางถูกเปลี่ยน/ย้าย/ลบ หรือขนาดไม่ตรง งานพักไว้เพื่อป้องกันข้อมูลผิด');
    }
  }
  async destinationFolderId(id: string, signal: AbortSignal): Promise<string> {
    const folder = await this.getFile(id, signal);
    if (!folder || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('ไม่พบโฟลเดอร์ปลายทาง');
    return folder.id;
  }
  async ensureFolder(id: string, name: string, parent: string, key: string, signal: AbortSignal): Promise<void> {
    const existing = await this.getFile(id, signal);
    if (existing) { this.verify(existing, parent, key); return; }
    const response = await this.request(`${BASE}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ id, name, parents: [parent], mimeType: 'application/vnd.google-apps.folder', appProperties: { copyKey: key } }),
    });
    if (response.status !== 409) await this.check(response);
    const created = await this.getFile(id, signal);
    if (!created) throw new Error('ตรวจสอบโฟลเดอร์ที่สร้างไม่ได้ ลองทำต่ออีกครั้ง');
    this.verify(created, parent, key);
  }
  async upload(id: string, name: string, parent: string, key: string, size: number, mime: string, read: (start: number, end: number) => Promise<Blob>, signal: AbortSignal, state: UploadState, checkpoint: (state: UploadState) => Promise<void>): Promise<void> {
    const existing = await this.getFile(id, signal);
    if (existing) { this.verify(existing, parent, key, size); await checkpoint({ bytes: size }); return; }
    const metadata = { id, name, parents: [parent], mimeType: mime, appProperties: { copyKey: key } };
    if (mime.startsWith('application/vnd.google-apps.')) throw new Error('ไม่รองรับการแปลงไฟล์เป็น Google Workspace');
    if (size === 0) {
      const response = await this.request(`${BASE}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(metadata) });
      if (response.status !== 409) await this.check(response);
    } else {
      let url = state.url;
      if (url && new URL(url).origin !== 'https://www.googleapis.com') throw new Error('Saved upload URL ไม่ถูกต้อง');
      let offset = 0;
      let failures = 0;
      let query = Boolean(url);
      while (offset < size) {
        signal.throwIfAborted();
        if (!url) {
          const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
            method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(metadata),
          });
          if (response.status === 409) {
            const complete = await this.getFile(id, signal);
            if (!complete) throw new Error('Google destination ID conflict');
            this.verify(complete, parent, key, size); break;
          }
          await this.check(response);
          url = response.headers.get('Location') ?? undefined;
          if (!url || new URL(url).origin !== 'https://www.googleapis.com') throw new Error('Google upload URL ไม่ถูกต้อง');
          offset = 0; query = false;
          // Persist the session before sending any file data.
          await checkpoint({ url, bytes: 0 });
        }
        let response: Response;
        const end = Math.min(offset + COPY_CHUNK_BYTES, size);
        if (query) {
          response = await this.request(url, { method: 'PUT', signal, headers: { 'Content-Range': `bytes */${size}` } });
        } else {
          const chunk = await read(offset, end);
          if (chunk.size !== end - offset) throw new Error('ขนาดข้อมูล chunk ไม่ตรง');
          try {
            response = await this.request(url, { method: 'PUT', signal, headers: { 'Content-Type': mime, 'Content-Range': `bytes ${offset}-${end - 1}/${size}` }, body: chunk }, false);
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof GoogleAuthExpired || ++failures > 4) throw error;
            await waitForRetry(this.retryDelay * 2 ** (failures - 1), signal); query = true; continue;
          }
          const limited = response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(await response.clone().text());
          if (response.status >= 500 || response.status === 429 || limited) {
            if (++failures > 4) { await this.check(response); }
            await waitForRetry(this.retryDelay * 2 ** (failures - 1), signal); query = true; continue;
          }
        }
        if (response.ok) break;
        if (response.status === 404 || response.status === 410) {
          const completed = await this.getFile(id, signal);
          if (completed) { this.verify(completed, parent, key, size); break; }
          if (++failures > 4) throw new Error('Upload session หมดอายุซ้ำหลายครั้ง');
          url = undefined; await checkpoint({ bytes: 0 }); continue;
        }
        if (response.status !== 308) { await this.check(response); throw new Error('Upload ไม่สมบูรณ์'); }
        const range = response.headers.get('Range');
        const match = range?.match(/^bytes=0-(\d+)$/);
        if (range && !match) throw new Error('Google ส่งตำแหน่ง upload ไม่ถูกต้อง');
        const next = match ? Number(match[1]) + 1 : 0;
        if (!Number.isSafeInteger(next) || next > size || (!query && (next < offset || next > end))) throw new Error('ตำแหน่ง upload ไม่ตรง');
        if (next === size) throw new Error('Google ยังไม่ยืนยันว่า upload เสร็จ');
        if (next === offset && !query && ++failures > 4) throw new Error('Upload ไม่คืบหน้า');
        if (next > offset) failures = 0;
        offset = next; query = false; await checkpoint({ url, bytes: offset });
      }
    }
    const completed = await this.getFile(id, signal);
    if (!completed) throw new Error('ตรวจสอบไฟล์ปลายทางไม่ได้ กดทำต่อเพื่อตรวจใหม่');
    this.verify(completed, parent, key, size);
    await checkpoint({ bytes: size });
  }
}
