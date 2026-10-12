import { randomBytes } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const PREFIX = '/api/google/';
const COOKIE = 'drive_transfer_google';
const brokerKey = Symbol.for('drive-transfer.local-google-sessions');
const brokers = globalThis[brokerKey] ??= new Map();
/** Local-only token broker. Refresh tokens never leave this Node process. */
export function googleSessionHandler({ clientId, clientSecret, origin, clientFactory = () => new OAuth2Client({ clientId, clientSecret, redirectUri: `${origin}${PREFIX}callback`, transporterOptions: { timeout: 180000 } }) }) {
  // Survive Vite config restarts in the same Node process, without writing tokens to disk.
  const key = `${clientId}@${origin}`;
  const sessions = brokers.get(key) ?? new Map();
  brokers.set(key, sessions);
  const host = new URL(origin).host;
  if (new URL(origin).hostname !== 'localhost') throw new Error('Google auto refresh broker requires localhost');
  const respond = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', origin);
    if (!url.pathname.startsWith(PREFIX)) return next();
    if (req.headers.host !== host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return respond(res, 403, { error: 'Local access only' });
    const callback = url.pathname === `${PREFIX}callback`;
    if (callback ? req.method !== 'GET' : req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-drive-transfer'] !== '1') return respond(res, 403, { error: 'Invalid request origin' });
    if (!clientId || !clientSecret) return respond(res, 503, { error: 'ตั้งค่า GOOGLE_CLIENT_SECRET ก่อนใช้ต่ออายุอัตโนมัติ' });
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.usedAt > 7 * 86400000) sessions.delete(id);
    const id = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    let session = id ? sessions.get(id) : undefined;
    let body = {};
    try {
      if (!callback) {
        let size = 0; const parts = [];
        for await (const part of req) { size += part.length; if (size > 8192) return respond(res, 413, { error: 'Request too large' }); parts.push(part); }
        body = JSON.parse(Buffer.concat(parts).toString() || '{}');
      }
      if (url.pathname === `${PREFIX}start`) {
        if (!session) {
          if (sessions.size >= 32) return respond(res, 429, { error: 'Too many sessions' });
          const key = randomBytes(32).toString('base64url');
          session = { usedAt: now }; sessions.set(key, session);
          res.setHeader('Set-Cookie', `${COOKIE}=${key}; HttpOnly; SameSite=Lax; Path=/api/google; Max-Age=604800`);
        }
        const client = clientFactory();
        const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
        const state = randomBytes(32).toString('base64url');
        session.pending = { client, state, codeVerifier, expires: now + 600000 };
        session.result = undefined;
        const authUrl = client.generateAuthUrl({ scope: [SCOPE], access_type: 'offline', prompt: 'consent select_account', state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
        return respond(res, 200, { url: authUrl, attempt: state });
      }
      if (!session) return respond(res, 401, { error: 'ต้องเชื่อมต่อ Google อีกครั้ง' });
      session.usedAt = now;
      if (callback) {
        const pending = session.pending;
        if (!pending || pending.expires < now || url.searchParams.get('state') !== pending.state) return respond(res, 400, { error: 'Invalid OAuth state' });
        session.pending = undefined;
        try {
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) throw new Error('Consent denied');
          const { tokens } = await pending.client.getToken({ code, codeVerifier: pending.codeVerifier });
          if (!tokens.refresh_token || !tokens.access_token || !tokens.scope?.split(' ').includes(SCOPE)) throw new Error('Offline access missing');
          pending.client.setCredentials(tokens);
          const { data } = await pending.client.request({ url: 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)' });
          if (!data.user?.permissionId) throw new Error('Account identity missing');
          session.accountId = data.user.permissionId;
          session.client = pending.client; session.result = { attempt: pending.state, ok: true };
        } catch { session.result = { attempt: pending.state, ok: false }; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' });
        return res.end('<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>กลับไปหน้าคัดลอกได้แล้ว ปิดหน้าต่างนี้ได้</p>');
      }
      if (url.pathname === `${PREFIX}session` && body.attempt) {
        if (session.result?.attempt !== body.attempt) return respond(res, 202, { pending: true });
        if (!session.result.ok) return respond(res, 401, { error: 'เชื่อมต่ออัตโนมัติไม่สำเร็จ ต้องอนุญาต offline access' });
      }
      if (![`${PREFIX}session`, `${PREFIX}token`].includes(url.pathname)) return respond(res, 404, { error: 'Not found' });
      if (!session.client) return respond(res, 401, { error: 'ต้องเชื่อมต่อ Google อีกครั้ง' });
      if (!session.refreshing) {
        if (body.force && body.token === session.client.credentials.access_token) session.client.credentials.expiry_date = 1;
        session.refreshing = session.client.getAccessToken().finally(() => { session.refreshing = undefined; });
      }
      const { token } = await session.refreshing;
      if (!token) return respond(res, 401, { error: 'Google session หมดอายุ' });
      return respond(res, 200, { token, expiresAt: session.client.credentials.expiry_date, autoRefresh: true, accountId: session.accountId });
    } catch (error) {
      // Never send/log provider responses: they can contain credentials or auth codes.
      if (error?.response?.data?.error === 'invalid_grant') { if (session) session.client = undefined; return respond(res, 401, { error: 'Google ยกเลิกสิทธิ์/refresh token หมดอายุ ต้องเชื่อมต่อใหม่' }); }
      return respond(res, 503, { error: 'ติดต่อ Google เพื่อเติม session ไม่สำเร็จ ลองใหม่' });
    }
  };
}
