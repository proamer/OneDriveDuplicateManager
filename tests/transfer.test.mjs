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
await writeFile(entry, `export * from '${source}/src/features/transfer/transferTiming.ts'; export * from '${source}/src/services/graph/oneDriveService.ts'; export * from '${source}/src/services/google/googleDrive.ts'; export * from '${source}/src/features/transfer/transferService.ts'; export * from '${source}/src/features/transfer/transferRepository.ts'; export * from '${source}/src/features/transfer/transferNetwork.ts';`);
await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_GOOGLE_CLIENT_ID': '"test"' }, build: { outDir: directory, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'services.mjs' } } });
const { transferMetrics, durationText, createOneDriveService, GoogleDrive, GoogleAuthExpired, planCopy, resumeCopy, visibleCopyEntries, COPY_CONCURRENCY, transferRepository, checkMetadataSpace, downloadChunk, COPY_CHUNK_BYTES } = await import(pathToFileURL(join(directory, 'services.mjs')));
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const session = () => ({ token: 'fake-google-token', expiresAt: Date.now() + 3600000 });
const google = () => new GoogleDrive(session(), 0);
const file = { id: 'file', name: 'hello.txt', size: 3, file: { mimeType: 'text/plain' }, lastModifiedDateTime: '2026-10-09' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
test('ETA includes per-file overhead, downtime excludes active time, completion freezes clock', () => {
  const timing = { jobId: 'j', trackedFrom: 10000, activeMs: 20000, transferredBytes: 2000, completedFiles: 4, updatedAt: 40000 };
  const created = new Date(0).toISOString();
  const paused = transferMetrics(timing, created, 50000, false, 1000, 100);
  assert.equal(paused.elapsedMs, 50000); assert.equal(paused.activeMs, 20000);
  assert.equal(paused.downtimeMs, 20000); assert.equal(paused.unknownMs, 10000);
  assert.equal(paused.bytesPerSecond, 100); assert.equal(paused.etaMs, 500000);
  const active = transferMetrics(timing, created, 50000, true, 1000, 100);
  assert.equal(active.activeMs, 30000); assert.equal(active.downtimeMs, 10000);
  const done = transferMetrics({ ...timing, finishedAt: 40000 }, created, 999999, false, 0, 0);
  assert.equal(done.elapsedMs, 40000); assert.equal(done.downtimeMs, 10000); assert.equal(done.etaMs, 0);
  assert.equal(durationText(3661000), '1 ชม. 1 นาที 1 วินาที');
});
test('ETA does not invent a finish date without sufficient actual progress', () => {
  const timing = { jobId: 'j', trackedFrom: 0, activeMs: 30000, transferredBytes: 0, completedFiles: 4, updatedAt: 30000 };
  assert.equal(transferMetrics(timing, new Date(0).toISOString(), 30000, false, 100, 10).etaMs, undefined);
  assert.equal(transferMetrics({ ...timing, transferredBytes: 100, completedFiles: 1 }, new Date(0).toISOString(), 30000, false, 100, 10).etaMs, undefined);
});
test('visible rows prioritize active beyond row 500, paused, pending, then completed stably', () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ item: { ...file, id: String(i) }, parentId: 'root', path: String(i) }));
  const states = new Map(entries.slice(0, 550).map(entry => [entry.item.id, { done: true, status: 'สำเร็จ' }]));
  states.set('598', { done: false, status: 'กำลังคัดลอก' });
  states.set('597', { done: false, status: 'พักไว้' });
  const rows = visibleCopyEntries(entries, states);
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.slice(0, 3).map(entry => entry.item.id), ['598', '597', '550']);
  assert.equal(rows[49].item.id, '599'); assert.equal(rows[50].item.id, '0');
  assert.equal(entries[0].item.id, '0');
});
test('OneDrive missing selected download annotation falls back to fresh full metadata', async () => {
  const calls = []; const abort = signal();
  const full = { ...file, '@microsoft.graph.downloadUrl': 'https://download.example/file' };
  const graph = createOneDriveService({ json: async (path, options) => {
    calls.push(path); assert.equal(options.signal, abort);
    return path.includes('?') ? file : full;
  } });
  assert.deepEqual(await graph.getDownloadItem('id/with space', abort), full);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], '/me/drive/items/id%2Fwith%20space');
  assert.match(calls[0], /\$select=.*@microsoft\.graph\.downloadUrl/);
});
test('OneDrive existing URL, empty files and folders need no fallback', async () => {
  for (const metadata of [{ ...file, '@microsoft.graph.downloadUrl': 'https://download.example/file' }, { ...file, size: 0 }, { id: 'folder', name: 'folder', folder: {} }]) {
    let calls = 0;
    const graph = createOneDriveService({ json: async () => { calls++; return metadata; } });
    assert.deepEqual(await graph.getDownloadItem(metadata.id, signal()), metadata);
    assert.equal(calls, 1);
  }
});
test('OneDrive abort prevents fallback and full metadata errors propagate', async () => {
  const abort = new AbortController(); let calls = 0;
  const cancelled = createOneDriveService({ json: async () => { calls++; abort.abort(); return file; } });
  await assert.rejects(cancelled.getDownloadItem(file.id, abort.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  const failed = createOneDriveService({ json: async path => { if (!path.includes('?')) throw new Error('OneDrive unavailable'); return file; } });
  await assert.rejects(failed.getDownloadItem(file.id, signal()), /OneDrive unavailable/);
});
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
test('expired access token renews automatically before copying without pausing job', async () => {
  const remote = server(); const token = session(); token.expiresAt = 0; let renewals = 0;
  token.renew = async force => { assert.equal(force, false); renewals++; token.expiresAt = Date.now() + 3600000; token.token = 'fresh'; };
  await run(makeJob(), memoryStore(), new GoogleDrive(token, 0));
  assert.equal(renewals, 1); assert.equal(remote.files.size, 2);
});
test('401 during upload renews token then queries received offset before resending data', async () => {
  const remote = server(); const fetchFromServer = globalThis.fetch; let expired = false; let renewals = 0;
  globalThis.fetch = async (url, options) => {
    if (!expired && String(url).includes('/upload/session/') && options.headers['Content-Range'].startsWith('bytes 0-')) { expired = true; return json({}, 401); }
    return fetchFromServer(url, options);
  };
  const token = session(); token.renew = async force => { assert.equal(force, true); renewals++; token.token = 'fresh'; token.expiresAt = Date.now() + 3600000; };
  await run(makeJob(), memoryStore(), new GoogleDrive(token, 0));
  assert.equal(renewals, 1); assert.equal(remote.state.uploadedChunks, 1);
  assert.equal(remote.sessions.size, 1); assert.equal(remote.files.size, 2);
  // The query response has no bytes: the same fixed ID/session is reused.
  assert.equal(remote.calls.filter(([method, url]) => method === 'PUT' && url.includes('/upload/session/')).length, 2);
});
test('timing persists pause and resume without counting previously copied bytes again', async () => {
  server(); const job = makeJob({ ...file, size: COPY_CHUNK_BYTES + 3 });
  const records = memoryStore(); const abort = new AbortController(); let timing;
  const store = { ...records, timing: async () => timing, saveTiming: async value => { timing = structuredClone(value); }, saveCheckpoint: async value => { await records.saveCheckpoint(value); if (value.bytes === COPY_CHUNK_BYTES) abort.abort(); } };
  await assert.rejects(run(job, store, google(), abort.signal), { name: 'AbortError' });
  assert.equal(timing.transferredBytes, COPY_CHUNK_BYTES); assert.equal(timing.completedFiles, 0);
  assert.equal(timing.finishedAt, undefined); const active = timing.activeMs; const tracked = timing.trackedFrom;
  await run(job, { ...store, saveCheckpoint: records.saveCheckpoint });
  assert.equal(timing.transferredBytes, COPY_CHUNK_BYTES + 3); assert.equal(timing.completedFiles, 1);
  assert.ok(timing.activeMs >= active); assert.equal(timing.trackedFrom, tracked); assert.ok(timing.finishedAt);
});
test('failed timing commit prevents remote writes', async () => {
  const remote = server(); const records = memoryStore();
  await assert.rejects(run(makeJob(), { ...records, timing: async () => undefined, saveTiming: async () => { throw new Error('timing disk full'); } }), /timing disk full/);
  assert.equal(remote.files.size, 0); assert.equal(remote.calls.length, 0);
});
test('parallel files are bounded, parents exist first, completed work is skipped on resume', async () => {
  const remote = server(); const job = makeJob(); const store = memoryStore();
  job.entries = [{ item: { id: 'child', name: 'child', folder: {} }, parentId: 'root', path: 'child' }, ...Array.from({ length: 8 }, (_, i) => ({ item: { ...file, id: `file-${i}` }, parentId: 'child', path: `child/${i}` }))];
  const client = google(); const original = client.upload.bind(client);
  let active = 0; let maximum = 0; let starts = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  client.upload = async (...args) => {
    active++; starts++; maximum = Math.max(maximum, active);
    assert.ok(remote.files.has(args[2]), 'parent must already exist');
    if (starts === COPY_CONCURRENCY) release();
    await gate;
    try { return await original(...args); } finally { active--; }
  };
  let metadataReads = 0;
  const source = { getDownloadItem: async id => { metadataReads++; return { ...file, id, '@microsoft.graph.downloadUrl': 'https://download.example/file' }; } };
  await resumeCopy(job, 'microsoft', source, client, store, signal(), () => {});
  assert.equal(maximum, COPY_CONCURRENCY); assert.equal(active, 0); assert.equal(starts, 8);
  assert.equal(metadataReads, 8, 'first read reuses validated metadata');
  assert.equal(remote.files.size, 10);
  await resumeCopy(job, 'microsoft', source, client, store, signal(), () => {});
  assert.equal(starts, 8); assert.equal(remote.files.size, 10);
});
test('parallel failure aborts and drains siblings before returning; reconnect reuses IDs', async () => {
  const remote = server(); const job = makeJob(); const store = memoryStore();
  job.entries = Array.from({ length: 7 }, (_, i) => ({ item: { ...file, id: `file-${i}` }, parentId: 'root', path: String(i) }));
  const client = google(); let starts = 0; let active = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  client.upload = async (...args) => {
    starts++; active++;
    const number = starts; const abort = args[7];
    if (starts === COPY_CONCURRENCY) release();
    try {
      await gate;
      if (number === 1) throw new GoogleAuthExpired();
      await new Promise((resolve, reject) => {
        const finish = () => setImmediate(() => setImmediate(() => reject(abort.reason)));
        if (abort.aborted) finish(); else abort.addEventListener('abort', finish, { once: true });
      });
    } finally { active--; }
  };
  const source = { getDownloadItem: async id => ({ ...file, id, '@microsoft.graph.downloadUrl': 'https://download.example/file' }) };
  await assert.rejects(resumeCopy(job, 'microsoft', source, client, store, signal(), () => {}), GoogleAuthExpired);
  assert.equal(active, 0); assert.equal(starts, COPY_CONCURRENCY);
  const ids = new Map((await store.checkpoints(job.id)).map(state => [state.sourceId, state.destinationId]));
  await resumeCopy(job, 'microsoft', source, google(), store, signal(), () => {});
  assert.equal(remote.files.size, 8);
  for (const state of await store.checkpoints(job.id)) {
    assert.equal(state.done, true);
    if (ids.has(state.sourceId)) assert.equal(state.destinationId, ids.get(state.sourceId));
  }
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
test('timing database upgrade preserves existing v1 job and checkpoints', async () => {
  const job = makeJob();
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('onedrive-google-copy', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' });
      request.result.createObjectStore('checkpoints', { keyPath: ['jobId', 'sourceId'] }).createIndex('job', 'jobId');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(['jobs', 'checkpoints'], 'readwrite');
      tx.objectStore('jobs').put(job);
      tx.objectStore('checkpoints').put({ jobId: job.id, sourceId: file.id, destinationId: 'old-id', bytes: 2, done: false });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  });
  assert.deepEqual((await transferRepository.jobs()).find(value => value.id === job.id), job);
  assert.equal((await transferRepository.checkpoints(job.id))[0].destinationId, 'old-id');
  assert.equal(await transferRepository.timing(job.id), undefined);
  const timing = { jobId: job.id, trackedFrom: 12345, activeMs: 5000, transferredBytes: 2, completedFiles: 0, updatedAt: 17345 };
  await transferRepository.saveTiming(timing);
  assert.deepEqual(await transferRepository.timing(job.id), timing);
  assert.equal((await transferRepository.checkpoints(job.id))[0].bytes, 2);
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
