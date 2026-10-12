import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { googleSessionHandler } from '../server/googleSession.mjs';

async function fixture(action) {
  let refreshes = 0;
  const scope = 'https://www.googleapis.com/auth/drive';
  const client = {
    credentials: {}, revoked: false,
    generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
    generateAuthUrl: options => { assert.equal(options.access_type, 'offline'); assert.equal(options.code_challenge_method, 'S256'); return `https://accounts.google.com/o/oauth2/v2/auth?state=${options.state}`; },
    getToken: async options => { assert.equal(options.codeVerifier, 'verifier'); return { tokens: { access_token: 'initial', refresh_token: 'private-refresh', expiry_date: Date.now() + 3600000, scope } }; },
    setCredentials: value => { client.credentials = value; },
    request: async () => ({ data: { user: { permissionId: 'same-account' } } }),
    getAccessToken: async () => {
      if (client.revoked) throw { response: { data: { error: 'invalid_grant', secret: 'never expose' } } };
      if (client.credentials.expiry_date < Date.now() + 60000) {
        refreshes++;
        await new Promise(resolve => setTimeout(resolve, 15));
        client.credentials.access_token = `renewed-${refreshes}`; client.credentials.expiry_date = Date.now() + 3600000;
      }
      return { token: client.credentials.access_token };
    },
  };
  let origin;
  let handler;
  const server = createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${server.address().port}`;
  handler = googleSessionHandler({ origin, clientId: 'public', clientSecret: 'private', clientFactory: () => client });
  let cookie = '';
  const post = async (path, body = {}, headers = {}) => {
    const response = await fetch(`${origin}/api/google/${path}`, { method: 'POST', headers: { Origin: origin, 'X-Drive-Transfer': '1', Cookie: cookie, ...headers }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const authorize = async () => {
    const start = await post('start');
    assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const data = await start.json();
    const bad = await fetch(`${origin}/api/google/callback?state=wrong&code=code`, { headers: { Cookie: cookie } });
    assert.equal(bad.status, 400);
    const callback = await fetch(`${origin}/api/google/callback?state=${data.attempt}&code=code`, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200);
    assert.equal((await callback.text()).includes('private-refresh'), false);
    return data.attempt;
  };
  try { await action({ post, authorize, client, origin, refreshes: () => refreshes, cookie: () => cookie }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('offline broker validates state, protects tokens from cross-origin and GET requests', async () => fixture(async ({ post, authorize, origin }) => {
  assert.equal((await post('start', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${origin}/api/google/token`)).status, 403);
  const attempt = await authorize();
  const response = await post('session', { attempt });
  const body = await response.json();
  assert.equal(body.token, 'initial'); assert.equal(body.accountId, 'same-account');
  assert.equal(JSON.stringify(body).includes('private-refresh'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}));
test('concurrent token requests renew once; stale 401 cannot force a second refresh', async () => fixture(async ({ post, authorize, client, refreshes }) => {
  await authorize(); client.credentials.expiry_date = 1;
  const results = await Promise.all(Array.from({ length: 3 }, () => post('token', { force: true, token: 'initial' }).then(value => value.json())));
  assert.equal(refreshes(), 1); assert.deepEqual(results.map(value => value.token), ['renewed-1', 'renewed-1', 'renewed-1']);
  await post('token', { force: true, token: 'initial' }); assert.equal(refreshes(), 1);
}));
test('revocation requires reconnect and does not expose provider secrets', async () => fixture(async ({ post, authorize, client }) => {
  await authorize(); client.revoked = true;
  const response = await post('token'); assert.equal(response.status, 401);
  assert.equal((await response.text()).includes('never expose'), false);
  assert.equal((await post('token')).status, 401);
}));
