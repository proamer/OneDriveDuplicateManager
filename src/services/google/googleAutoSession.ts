import { timedFetch } from '../../features/transfer/transferNetwork';
import { GoogleAuthExpired, type GoogleSession } from './googleDrive';
export const googleAutoRefresh = Boolean(import.meta.env.VITE_GOOGLE_AUTO_REFRESH);
interface BrokerToken { token: string; expiresAt: number; accountId: string }
async function broker(path: string, body: object = {}): Promise<Response> {
  return timedFetch(`/api/google/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Drive-Transfer': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function sessionOf(value: BrokerToken): GoogleSession {
  if (!value.token || !Number.isFinite(value.expiresAt) || !value.accountId) throw new GoogleAuthExpired();
  const session: GoogleSession = { token: value.token, expiresAt: value.expiresAt };
  let refreshing: Promise<void> | undefined;
  session.renew = force => refreshing ??= (async () => {
    const response = await broker('token', { force, token: session.token });
    if (response.status === 401) throw new GoogleAuthExpired();
    if (!response.ok) throw new Error('เติม Google session ไม่สำเร็จ');
    const next = await response.json() as BrokerToken;
    if (next.accountId !== value.accountId || !next.token || !Number.isFinite(next.expiresAt)) throw new GoogleAuthExpired();
    session.token = next.token; session.expiresAt = next.expiresAt;
  })().finally(() => { refreshing = undefined; });
  return session;
}
export async function restoreGoogleSession(): Promise<GoogleSession | null> {
  if (!googleAutoRefresh) return null;
  const response = await broker('session');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('เชื่อมต่อ Google backend ไม่สำเร็จ');
  return sessionOf(await response.json() as BrokerToken);
}
/** Open synchronously from the user's click, then navigate after the CSRF-protected handshake. */
export function connectGoogleAutomatic(): Promise<GoogleSession> {
  const popup = window.open('about:blank', 'google-drive-offline', 'width=520,height=720');
  if (!popup) return Promise.reject(new Error('อนุญาต popup เพื่อเชื่อมต่อ Google'));
  return (async () => {
    try {
      const start = await broker('start');
      if (!start.ok) throw new Error('เริ่มเชื่อมต่อ Google ไม่สำเร็จ');
      const { url, attempt } = await start.json() as { url: string; attempt: string };
      if (new URL(url).origin !== 'https://accounts.google.com') throw new Error('Google authorization URL ไม่ถูกต้อง');
      popup.location.href = url;
      const until = Date.now() + 600000;
      while (Date.now() < until) {
        const response = await broker('session', { attempt });
        if (response.status === 200) return sessionOf(await response.json() as BrokerToken);
        if (response.status !== 202) throw new Error('เชื่อมต่อ Google ไม่สำเร็จ ต้องอนุญาต offline access');
        // COOP may sever the popup handle; poll the server, not popup.closed.
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('หมดเวลารอเชื่อมต่อ Google');
    } finally { try { popup.close(); } catch { /* Google COOP can sever this handle. */ } }
  })();
}
