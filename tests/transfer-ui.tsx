// Isolated browser QA fixture. All cloud calls are intercepted; no real credentials or files.
import { createRoot } from 'react-dom/client';
import { AuthContext, type AuthContextValue } from '../src/features/auth/AuthProvider';
import { TransferPage } from '../src/features/transfer/TransferPage';
import { transferRepository, type TransferJob } from '../src/features/transfer/transferRepository';
import '../src/index.css';
const caseId = new URLSearchParams(window.location.search).get('case') ?? 'manual';
const size = 8 * 1024 * 1024 + 3;
const file = { id: 'ui-file', name: 'sample.bin', size, file: { mimeType: 'application/octet-stream' }, lastModifiedDateTime: '2026-10-09' };
const job: TransferJob = { id: `ui-resume-job-${caseId}`, createdAt: '2026-10-09', microsoftAccountId: `ui-microsoft-${caseId}`, googleAccountId: 'ui-google', googleEmail: 'test@example.com', source: { id: 'ui-source', name: 'Documents', path: 'OneDrive / Documents' }, target: { id: 'ui-target', name: 'Backup', path: 'My Drive / Backup' }, copyName: 'Documents - Resume test', entries: [{ item: file, parentId: 'ui-source', path: 'sample.bin' }] };
if (!(await transferRepository.jobs()).some(value => value.id === job.id)) {
  await transferRepository.saveJob(job);
  await transferRepository.saveCheckpoint({ jobId: job.id, sourceId: 'ui-source', destinationId: 'ui-copy-root', bytes: 0, done: true });
  await transferRepository.saveCheckpoint({ jobId: job.id, sourceId: file.id, destinationId: 'ui-destination-file', bytes: 0, done: false, uploadUrl: 'https://www.googleapis.com/upload/ui-test' });
}
window.google = { accounts: { oauth2: { initTokenClient: options => ({ requestAccessToken: () => options.callback({ access_token: 'ui-fake-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' }) }) } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const original = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://download.example/')) {
    const match = (init!.headers as Record<string, string>).Range.match(/bytes=(\d+)-(\d+)/)!;
    return new Response(new Uint8Array(Number(match[2]) - Number(match[1]) + 1), { status: 206 });
  }
  if (!url.startsWith('https://www.googleapis.com/')) return original(input, init);
  if (url.includes('/about?')) return json({ user: { permissionId: 'ui-google', emailAddress: 'test@example.com' } });
  if (url.includes('/files/ui-copy-root?')) return json({ id: 'ui-copy-root', name: job.copyName, mimeType: 'application/vnd.google-apps.folder', parents: ['ui-target'], appProperties: { copyKey: `${job.id}:root` } });
  if (url.includes('/files/ui-destination-file?')) return localStorage.getItem(`ui-offset-${caseId}`) === String(size) ? json({ id: 'ui-destination-file', name: file.name, size: String(size), mimeType: 'application/octet-stream', parents: ['ui-copy-root'], appProperties: { copyKey: `${job.id}:${file.id}` } }) : json({}, 404);
  if (url.includes('/upload/ui-test')) {
    const range = (init!.headers as Record<string, string>)['Content-Range'];
    let bytes = Number(localStorage.getItem(`ui-offset-${caseId}`) ?? 0);
    if (!range.startsWith('bytes */')) {
      if (bytes > 0 && !localStorage.getItem(`ui-expired-once-${caseId}`)) { localStorage.setItem(`ui-expired-once-${caseId}`, 'yes'); return json({}, 401); }
      const match = range.match(/bytes (\d+)-(\d+)\//)!;
      if (Number(match[1]) !== bytes) throw new Error('Duplicate/wrong range');
      bytes = Number(match[2]) + 1; localStorage.setItem(`ui-offset-${caseId}`, String(bytes));
    }
    return bytes === size ? json({ id: 'ui-destination-file' }) : new Response('', { status: 308, headers: bytes ? { Range: `bytes=0-${bytes - 1}` } : {} });
  }
  throw new Error(`Unmocked Google request: ${url}`);
};
const auth = { status: 'authenticated', configured: true, error: null, account: { homeAccountId: `ui-microsoft-${caseId}`, username: 'test@example.com' }, graph: { getDownloadItem: async () => ({ ...file, '@microsoft.graph.downloadUrl': 'https://download.example/sample' }), listDriveRootChildren: async () => ({ value: [] }) }, login: async () => {}, logout: async () => {}, getAccessToken: async () => 'ui-fake-ms-token' } as unknown as AuthContextValue;
createRoot(document.getElementById('root')!).render(<AuthContext.Provider value={auth}><main className="page" style={{ maxWidth: 1200, margin: '0 auto' }}><TransferPage /></main></AuthContext.Provider>);

