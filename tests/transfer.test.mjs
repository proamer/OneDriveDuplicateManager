import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';

const directory = await mkdtemp(join(tmpdir(), 'drive-copy-test-'));
const entry = join(directory, 'entry.ts');
const source = process.cwd().replace(/\\/g, '/');
await writeFile(entry, `export * from '${source}/src/services/google/googleDrive.ts'; export * from '${source}/src/features/transfer/transferService.ts'; export * from '${source}/src/features/transfer/transferRepository.ts'; export * from '${source}/src/features/transfer/transferNetwork.ts';`);
await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_GOOGLE_CLIENT_ID': '"test"' }, build: { outDir: directory, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'services.mjs' } } });
const { GoogleDrive, GoogleAuthExpired, planCopy, resumeCopy, transferRepository, checkMetadataSpace, downloadChunk, COPY_CHUNK_BYTES } = await import(pathToFileURL(join(directory, 'services.mjs')));
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const session = () => ({ token: 'fake-google-token', expiresAt: Date.now() + 3600000 });
const google = () => new GoogleDrive(session(), 0);
const file = { id: 'file', name: 'hello.txt', size: 3, file: { mimeType: 'text/plain' }, lastModifiedDateTime: '2026-10-09' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
function makeJob(item = file) {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), microsoftAccountId: 'microsoft', googleAccountId: 'google', googleEmail: 'amp@example.com', source: { id: 'root', name: 'OneDrive', path: 'OneDrive' }, target: { id: 'target', name: 'My Drive', path: 'My Drive' }, copyName: 'Copy', entries: [{ item, parentId: 'root', path: item.name }] };
}
function memoryStore() {
  const records = new Map();
  return { records, checkpoints: async job => [...records.values()].filter(value => value.jobId === job).map(value => structuredClone(value)), saveCheckpoint: async value => records.set(`${value.jobId}/${value.sourceId}`, structuredClone(value)) };
}
function server() {
  const files = new Map(); const sessions = new Map(); const calls = []; const downloadRanges = [];
  const state = { account: 'google', loseCreate: false, loseChunk: false, expireSession: false, serverErrors: 0, generated: 0, uploadedChunks: 0 };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url); const parsed = new URL(url); const method = init.method ?? 'GET';
    calls.push([method, url]);
    if (parsed.hostname === 'download.example') {
      assert.equal(init.headers.Authorization, undefined);
      const range = init.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(range[1]); const end = Number(range[2]) + 1;
      assert.ok(end - start <= COPY_CHUNK_BYTES);
      downloadRanges.push([start, end]);
      return new Response(new Uint8Array(end - start), { status: 206 });
    }
    if (state.serverErrors > 0) { state.serverErrors--; return json({ error: { message: 'temporary' } }, 503); }
    if (parsed.pathname.endsWith('/about')) return json({ user: { permissionId: state.account, emailAddress: 'amp@example.com' } });
    if (parsed.pathname.endsWith('/generateIds')) return json({ ids: [`generated-${++state.generated}`] });
    if (parsed.pathname.startsWith('/upload/session/')) {
      const upload = sessions.get(url);
      if (!upload || state.expireSession) { state.expireSession = false; sessions.delete(url); return json({}, 404); }
      const range = init.headers['Content-Range'];
      if (range.startsWith('bytes */')) return upload.bytes === upload.size ? json(upload.metadata) : new Response('', { status: 308, headers: upload.bytes ? { Range: `bytes=0-${upload.bytes - 1}` } : {} });
      const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      assert.equal(Number(match[1]), upload.bytes);
      assert.equal(init.body.size, Number(match[2]) + 1 - Number(match[1]));
      upload.bytes = Number(match[2]) + 1; state.uploadedChunks++;
      if (upload.bytes === upload.size) files.set(upload.metadata.id, { ...upload.metadata, size: String(upload.size) });
      if (state.loseChunk) { state.loseChunk = false; throw new TypeError('lost response after Google accepted data'); }
      return upload.bytes === upload.size ? json(upload.metadata) : new Response('', { status: 308, headers: { Range: `bytes=0-${upload.bytes - 1}` } });
    }
    if (parsed.pathname.startsWith('/upload/drive/v3/files')) {
      const metadata = JSON.parse(init.body);
      if (files.has(metadata.id)) return json({}, 409);
      const url = `https://www.googleapis.com/upload/session/${sessions.size + 1}`;
      sessions.set(url, { metadata, size: Number(init.headers['X-Upload-Content-Length']), bytes: 0 });
      return new Response('', { status: 200, headers: { Location: url } });
    }
    if (method === 'GET' && parsed.pathname.includes('/files/')) {
      const id = decodeURIComponent(parsed.pathname.split('/').at(-1));
      return files.has(id) ? json(files.get(id)) : json({}, 404);
    }
    if (method === 'POST' && parsed.pathname.endsWith('/files')) {
      const metadata = JSON.parse(init.body);
      if (files.has(metadata.id)) return json({}, 409);
      files.set(metadata.id, { ...metadata, ...(metadata.mimeType !== 'application/vnd.google-apps.folder' ? { size: '0' } : {}) });
      if (state.loseCreate) { state.loseCreate = false; throw new TypeError('lost create response'); }
      return json({ id: metadata.id });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return { files, sessions, calls, state, downloadRanges };
}
const graph = item => ({ getDownloadItem: async () => ({ ...item, '@microsoft.graph.downloadUrl': 'https://download.example/file' }) });
const run = (job, store, client = google(), operation = signal()) => resumeCopy(job, 'microsoft', graph(job.entries[0]?.item ?? file), client, store, operation, () => {});

test('plan includes pages, nested and empty folders in parent-first order', async () => {
  const entries = await planCopy({ listDriveRootChildren: async () => ({ value: [{ id: 'folder', name: 'Documents', folder: {} }], '@odata.nextLink': 'next' }), listChildrenPage: async () => ({ value: [{ id: 'empty', name: 'Empty', folder: {} }] }), listDriveItemChildren: async id => ({ value: id === 'folder' ? [file] : [] }) }, 'root', signal());
  assert.deepEqual(entries.map(entry => [entry.path, entry.parentId]), [['Documents', 'root'], ['Empty', 'root'], ['Documents/hello.txt', 'folder']]);
});
test('special items and missing sizes are rejected', async () => {
  for (const item of [{ id: 'link', name: 'Shortcut' }, { ...file, size: undefined }]) await assert.rejects(planCopy({ listDriveRootChildren: async () => ({ value: [item] }) }, 'root', signal()));
});
test('resume skips completed files and keeps the same destination root', async () => {
  const remote = server(); const job = makeJob(); const store = memoryStore();
  await run(job, store); const count = remote.state.uploadedChunks; const created = remote.files.size;
  await run(job, store);
  assert.equal(remote.state.uploadedChunks, count); assert.equal(remote.files.size, created);
  assert.equal(remote.files.size, 2); assert.equal(remote.downloadRanges.length, 1);
});
test('lost folder create response retries its persisted ID without duplicates', async () => {
  const remote = server(); remote.state.loseCreate = true;
  const job = makeJob(); const store = memoryStore(); await run(job, store);
  assert.equal(remote.files.size, 2);
  assert.equal([...remote.files.values()].filter(value => value.mimeType === 'application/vnd.google-apps.folder').length, 1);
});
test('lost chunk response queries the same session before sending the next bytes', async () => {
  const remote = server(); remote.state.loseChunk = true; const job = makeJob({ ...file, size: COPY_CHUNK_BYTES + 3 });
  await run(job, memoryStore());
  assert.deepEqual(remote.downloadRanges, [[0, COPY_CHUNK_BYTES], [COPY_CHUNK_BYTES, COPY_CHUNK_BYTES + 3]]);
  assert.equal(remote.state.uploadedChunks, 2); assert.equal(remote.sessions.size, 1);
});
test('Google expiry pauses at the committed chunk; reconnect resumes that file', async () => {
  const remote = server(); const job = makeJob({ ...file, size: COPY_CHUNK_BYTES + 3 });
  const records = memoryStore(); const token = session();
  const store = { ...records, saveCheckpoint: async checkpoint => { await records.saveCheckpoint(checkpoint); if (checkpoint.sourceId === file.id && checkpoint.bytes === COPY_CHUNK_BYTES) token.expiresAt = 0; } };
  await assert.rejects(run(job, store, new GoogleDrive(token, 0)), GoogleAuthExpired);
  const saved = await records.checkpoints(job.id);
  assert.equal(saved.find(value => value.sourceId === file.id).bytes, COPY_CHUNK_BYTES);
  const ranges = remote.downloadRanges.length;
  await run(job, records);
  assert.deepEqual(remote.downloadRanges.slice(ranges), [[COPY_CHUNK_BYTES, COPY_CHUNK_BYTES + 3]]);
  assert.equal(remote.sessions.size, 1); assert.equal(remote.files.size, 2);
});
test('pause followed by reopening resumes server offset, not stale local offset', async () => {
  const remote = server(); const job = makeJob({ ...file, size: COPY_CHUNK_BYTES + 3 }); const records = memoryStore(); const controller = new AbortController();
  const store = { ...records, saveCheckpoint: async checkpoint => { await records.saveCheckpoint(checkpoint); if (checkpoint.sourceId === file.id && checkpoint.bytes === COPY_CHUNK_BYTES) controller.abort(); } };
  await assert.rejects(run(job, store, google(), controller.signal), { name: 'AbortError' });
  const checkpoint = (await records.checkpoints(job.id)).find(value => value.sourceId === file.id);
  checkpoint.bytes = 0; await records.saveCheckpoint(checkpoint);
  await run(job, records);
  assert.deepEqual(remote.downloadRanges, [[0, COPY_CHUNK_BYTES], [COPY_CHUNK_BYTES, COPY_CHUNK_BYTES + 3]]);
});
test('expired upload session restarts only its unfinished file using the same ID', async () => {
  const remote = server(); const job = makeJob({ ...file, size: COPY_CHUNK_BYTES + 3 }); const records = memoryStore(); const controller = new AbortController();
  const store = { ...records, saveCheckpoint: async checkpoint => { await records.saveCheckpoint(checkpoint); if (checkpoint.sourceId === file.id && checkpoint.bytes === COPY_CHUNK_BYTES) controller.abort(); } };
  await assert.rejects(run(job, store, google(), controller.signal));
  const id = (await records.checkpoints(job.id)).find(value => value.sourceId === file.id).destinationId;
  remote.state.expireSession = true; await run(job, records);
  assert.equal(remote.files.size, 2); assert.ok(remote.files.has(id));
});
test('completion accepted remotely but local commit fails: reconcile without reupload', async () => {
  const remote = server(); const job = makeJob(); const records = memoryStore();
  const store = { ...records, saveCheckpoint: async checkpoint => { if (checkpoint.sourceId === file.id && checkpoint.bytes === 3) throw new DOMException('disk full', 'QuotaExceededError'); await records.saveCheckpoint(checkpoint); } };
  await assert.rejects(run(job, store), { name: 'QuotaExceededError' });
  assert.equal(remote.state.uploadedChunks, 1);
  await run(job, records); assert.equal(remote.state.uploadedChunks, 1); assert.equal(remote.files.size, 2);
});
test('failed allocation checkpoint creates no remote files', async () => {
  const remote = server(); const job = makeJob();
  await assert.rejects(run(job, { checkpoints: async () => [], saveCheckpoint: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(remote.files.size, 0); assert.equal(remote.sessions.size, 0);
});
test('wrong Google or Microsoft account cannot mutate destinations', async () => {
  const remote = server(); const job = makeJob(); const store = memoryStore();
  remote.state.account = 'other'; await assert.rejects(run(job, store), /บัญชีเดิม/);
  await assert.rejects(resumeCopy(job, 'other', {}, google(), store, signal(), () => {}), /บัญชีเดิม/);
  assert.equal(remote.state.generated, 0); assert.equal(remote.files.size, 0);
});
test('changed source pauses before upload', async () => {
  const remote = server(); const job = makeJob();
  await assert.rejects(resumeCopy(job, 'microsoft', graph({ ...file, size: 4 }), google(), memoryStore(), signal(), () => {}), /ต้นทางเปลี่ยน/);
  assert.equal(remote.state.uploadedChunks, 0);
});
test('zero-byte file is created once without reading file content', async () => {
  const remote = server(); const job = makeJob({ ...file, size: 0 }); const store = memoryStore();
  await run(job, store); await run(job, store);
  assert.equal(remote.files.size, 2); assert.equal(remote.downloadRanges.length, 0);
});
test('119GB resume near end downloads only the remaining 3 bytes', async () => {
  const remote = server(); const size = 119 * 1024 ** 3; const metadata = { id: 'huge', name: 'huge.bin', parents: ['target'], mimeType: 'application/octet-stream', appProperties: { copyKey: 'key' } };
  const url = 'https://www.googleapis.com/upload/session/huge';
  remote.sessions.set(url, { metadata, size, bytes: size - 3 }); const reads = [];
  await google().upload('huge', 'huge.bin', 'target', 'key', size, metadata.mimeType, async (start, end) => { reads.push([start, end]); assert.ok(end - start <= COPY_CHUNK_BYTES); return new Blob([new Uint8Array(end - start)]); }, signal(), { url, bytes: 0 }, async () => {});
  assert.deepEqual(reads, [[size - 3, size]]); assert.equal(remote.state.uploadedChunks, 1);
});
test('server ignoring ranges is rejected before buffering the response', async () => {
  globalThis.fetch = async () => new Response('ignored range', { status: 200 });
  await assert.rejects(downloadChunk('https://download.example/file', 0, COPY_CHUNK_BYTES, 119 * 1024 ** 3, signal()), /ตามช่วง/);
});
test('even a malformed 206 cannot buffer more than one chunk', async () => {
  globalThis.fetch = async () => new Response(new Uint8Array(COPY_CHUNK_BYTES + 1), { status: 206 });
  await assert.rejects(downloadChunk('https://download.example/file', 0, COPY_CHUNK_BYTES, COPY_CHUNK_BYTES + 1, signal()), /เกินขนาด/);
});
test('IndexedDB restores job and per-file checkpoint without tokens or content', async () => {
  const job = makeJob(); await transferRepository.saveJob(job);
  await transferRepository.saveCheckpoint({ jobId: job.id, sourceId: file.id, destinationId: 'fixed-id', bytes: 3, done: true });
  const saved = (await transferRepository.jobs()).find(value => value.id === job.id);
  assert.deepEqual(saved, job);
  assert.deepEqual(await transferRepository.checkpoints(job.id), [{ jobId: job.id, sourceId: file.id, destinationId: 'fixed-id', bytes: 3, done: true }]);
  assert.ok(!JSON.stringify(saved).includes('fake-google-token'));
});
test('low metadata quota prevents starting a large job', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => ({ quota: 10, usage: 9 }) } } });
  try { await assert.rejects(checkMetadataSpace(makeJob().entries), /เหลือไม่พอ/); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
});
test('temporary Google failures retry and abort prevents writes', async () => {
  const remote = server(); remote.state.serverErrors = 2; await run(makeJob(), memoryStore());
  assert.equal(remote.files.size, 2);
  const controller = new AbortController(); controller.abort(); const before = remote.calls.length;
  await assert.rejects(run(makeJob(), memoryStore(), google(), controller.signal), { name: 'AbortError' });
  assert.equal(remote.calls.length, before);
});
