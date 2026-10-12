import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { CloudFolderBrowser, type FolderChoice } from './CloudFolderBrowser';
import { GoogleDrive, GoogleAuthExpired, connectGoogle, googleConfigured, loadGoogleIdentity, type GoogleSession } from '../../services/google/googleDrive';
import { COPY_CONCURRENCY, visibleCopyEntries, planCopy, resumeCopy, type CopyEntry } from './transferService';
import { checkMetadataSpace, transferRepository, type TransferJob, type TransferCheckpoint } from './transferRepository';
import { formatBytes } from '../../utils/formatBytes';
import { messageOf } from '../../utils/errorMessage';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { downloadChunk } from './transferNetwork';
import { durationText, transferMetrics, type TransferTiming } from './transferTiming';
import { googleAutoRefresh, connectGoogleAutomatic, restoreGoogleSession } from '../../services/google/googleAutoSession';

type Phase = 'idle' | 'loading' | 'connecting' | 'planning' | 'copying' | 'done' | 'paused';
export function TransferPage() {
  const { graph, account } = useAuth();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<GoogleSession | null>(null);
  const [googleName, setGoogleName] = useState('');
  const [source, setSource] = useState<FolderChoice | null>(null);
  const [target, setTarget] = useState<FolderChoice | null>(null);
  const [entries, setEntries] = useState<CopyEntry[] | null>(null);
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [job, setJob] = useState<TransferJob | null>(null);
  const results = useRef(new Map<string, TransferCheckpoint & { status: string }>());
  const [, renderResults] = useState(0);
  const [progress, setProgress] = useState({ bytes: 0, completed: 0 });
  const [timing, setTiming] = useState<TransferTiming | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileSizes = useMemo(() => new Map((entries ?? []).filter(entry => entry.item.file).map(entry => [entry.item.id, entry.item.size ?? 0])), [entries]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [copyName, setCopyName] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const google = useMemo(() => session ? new GoogleDrive(session) : null, [session]);
  const busy = ['loading', 'planning', 'copying', 'connecting'].includes(phase);
  const total = useMemo(() => [...fileSizes.values()].reduce((sum, size) => sum + size, 0), [fileSizes]);
  const bytes = progress.bytes;
  const completed = progress.completed;
  const metrics = job && timing ? transferMetrics(timing, job.createdAt, now, phase === 'copying', Math.max(0, total - bytes), Math.max(0, fileSizes.size - completed)) : null;
  useEffect(() => {
    if (!job || phase === 'done') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, phase]);
  const outputId = job ? results.current.get(job.source.id)?.destinationId : undefined;
  const visibleEntries = visibleCopyEntries(entries ?? [], results.current);
  const loadSdk = useCallback(() => {
    if (googleAutoRefresh) { setReady(true); return; }
    if (googleConfigured) void loadGoogleIdentity().then(() => { if (mounted.current) setReady(true); }).catch(error => { if (mounted.current) setError(messageOf(error)); });
  }, []);
  useEffect(() => {
    if (!googleAutoRefresh) return;
    let active = true;
    void restoreGoogleSession().then(async next => {
      if (!next) return;
      const identity = await new GoogleDrive(next).identity();
      if (active) { setSession(next); setGoogleName(identity.email); }
    }).catch(error => { if (active) setError(messageOf(error)); });
    return () => { active = false; };
  }, []);
  const restore = useCallback(async (saved: TransferJob) => {
    setPhase('loading');
    const [states, savedTiming] = await Promise.all([transferRepository.checkpoints(saved.id), transferRepository.timing!(saved.id)]);
    if (!mounted.current) return;
    setJob(saved); setSource(saved.source); setTarget(saved.target); setEntries(saved.entries); setCopyName(saved.copyName);
    setTiming(savedTiming ?? null); setNow(Date.now());
    results.current = new Map(states.map(state => [state.sourceId, { ...state, status: state.done ? 'สำเร็จ' : 'พักไว้' }]));
    const files = new Set(saved.entries.filter(entry => entry.item.file).map(entry => entry.item.id));
    setProgress(states.filter(state => files.has(state.sourceId)).reduce((sum, state) => ({ bytes: sum.bytes + state.bytes, completed: sum.completed + Number(state.done) }), { bytes: 0, completed: 0 }));
    const byId = new Map(states.map(state => [state.sourceId, state]));
    const done = saved.entries.every(entry => byId.get(entry.item.id)?.done) && byId.get(saved.source.id)?.done;
    setPhase(done ? 'done' : 'paused'); setError('');
  }, []);
  useEffect(() => {
    mounted.current = true; loadSdk();
    void transferRepository.jobs().then(async saved => {
      if (!mounted.current) return;
      const mine = saved.filter(item => item.microsoftAccountId === account?.homeAccountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setJobs(mine);
      if (mine[0]) await restore(mine[0]); else setPhase('idle');
    }).catch(error => { if (mounted.current) { setError(messageOf(error)); setPhase('paused'); } });
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [account?.homeAccountId, loadSdk, restore]);
  useEffect(() => {
    if (phase !== 'copying' && phase !== 'planning') return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'copying') return;
    let active = true;
    let wake: WakeLockSentinel | undefined;
    const acquire = async () => {
      if (!navigator.wakeLock || document.visibilityState !== 'visible' || wake && !wake.released) return;
      try { const next = await navigator.wakeLock.request('screen'); if (active) wake = next; else await next.release(); } catch { /* Browser/OS may refuse. Durable resume still works. */ }
    };
    void acquire(); document.addEventListener('visibilitychange', acquire);
    return () => { active = false; document.removeEventListener('visibilitychange', acquire); void wake?.release(); };
  }, [phase]);
  const listOneDrive = useCallback(async (id: string, signal: AbortSignal) => {
    const folders: { id: string; name: string }[] = [];
    let page = id === 'root' ? await graph.listDriveRootChildren(signal) : await graph.listDriveItemChildren(id, signal);
    for (;;) {
      folders.push(...page.value.filter(item => item.folder).map(item => ({ id: item.id, name: item.name })));
      if (!page['@odata.nextLink']) return folders.sort((a, b) => a.name.localeCompare(b.name));
      page = await graph.listChildrenPage(page['@odata.nextLink'], signal);
    }
  }, [graph]);
  const listGoogle = useCallback((id: string, signal: AbortSignal) => google!.folders(id, signal), [google]);
  const clearPlan = () => { setEntries(null); setTiming(null); results.current.clear(); setProgress({ bytes: 0, completed: 0 }); setPhase('idle'); setError(''); };
  const newCopy = () => { clearPlan(); setJob(null); setSource(null); setTarget(null); setCopyName(''); };
  const connect = async () => {
    setPhase('connecting'); setError('');
    try {
      const next = await (googleAutoRefresh ? connectGoogleAutomatic() : connectGoogle());
      const identity = await new GoogleDrive(next).identity();
      if (job && identity.id !== job.googleAccountId) throw new Error(`งานนี้ใช้ Google บัญชี ${job.googleEmail} กรุณาเชื่อมต่อบัญชีเดิม`);
      setSession(next); setGoogleName(identity.email);
      if (!job) { setTarget(null); setEntries(null); }
    } catch (error) { setSession(null); setError(messageOf(error)); }
    finally { if (mounted.current) setPhase(job ? 'paused' : 'idle'); }
  };
  const inspect = async () => {
    if (!source || job) return;
    clearPlan(); setPhase('planning');
    const operation = new AbortController(); controller.current = operation;
    try {
      const planned = await planCopy(graph, source.id, operation.signal);
      await checkMetadataSpace(planned);
      if (mounted.current) { setEntries(planned); setPhase('idle'); }
    } catch (error) { if (mounted.current) { setPhase('paused'); if (!operation.signal.aborted) setError(messageOf(error)); } }
  };
  const testGoogleRefresh = async () => {
    if (!session?.renew) return;
    setPhase('connecting'); setError('');
    try {
      await session.renew(true);
      const identity = await new GoogleDrive(session).identity();
      if (job && identity.id !== job.googleAccountId) throw new Error('ต้องใช้ Google บัญชีเดิม');
      setNotice('ทดสอบต่ออายุ Google session อัตโนมัติสำเร็จ โดยไม่ล็อกอินซ้ำ');
    } catch (error) { setError(messageOf(error)); }
    finally { if (mounted.current) setPhase(job ? 'paused' : 'idle'); }
  };
  const testSource = async () => {
    const entry = entries?.find(entry => entry.item.file && !results.current.get(entry.item.id)?.done);
    if (!entry) return;
    const operation = new AbortController(); controller.current = operation;
    setPhase('planning'); setError(''); setNotice('');
    try {
      const fresh = await graph.getDownloadItem(entry.item.id, operation.signal);
      if (fresh.size !== entry.item.size || fresh.lastModifiedDateTime !== entry.item.lastModifiedDateTime) throw new Error(`ไฟล์ต้นทางเปลี่ยน: ${entry.path}`);
      if (fresh.size) {
        const url = fresh['@microsoft.graph.downloadUrl'];
        if (!url) throw new Error(`OneDrive ไม่ส่ง URL ดาวน์โหลดสำหรับ ${entry.path} แม้ขอ metadata เต็มแล้ว`);
        await downloadChunk(url, 0, 1, fresh.size, operation.signal);
      }
      if (mounted.current) setNotice(`ทดสอบอ่านต้นทางสำเร็จ: ${entry.path} (${formatBytes(fresh.size ?? 0)})`);
    } catch (error) { if (mounted.current && !operation.signal.aborted) setError(messageOf(error)); }
    finally { if (mounted.current) setPhase(job ? 'paused' : 'idle'); }
  };
  const run = async (create: boolean) => {
    setConfirm(false);
    if (!google || !account || !source || !target || !entries) return;
    const operation = new AbortController(); controller.current = operation;
    setPhase('copying'); setError('');
    try {
      if (!navigator.locks) throw new Error('ใช้ Chrome หรือ Edge ที่รองรับการล็อกงาน เพื่อป้องกันหลายแท็บคัดลอกซ้ำ');
      await navigator.locks.request('onedrive-google-copy-writer', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('มีแท็บอื่นกำลังคัดลอกอยู่ พักงานในแท็บนั้นก่อน');
        let activeJob = job;
        if (create) {
          const identity = await google.identity();
          const canonicalTarget = await google.destinationFolderId(target.id, operation.signal);
          await checkMetadataSpace(entries);
          activeJob = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), microsoftAccountId: account.homeAccountId, googleAccountId: identity.id, googleEmail: identity.email, source, target: { ...target, id: canonicalTarget }, copyName, entries };
          await transferRepository.saveJob(activeJob);
          setJob(activeJob); setTarget(activeJob.target); setJobs(previous => [activeJob!, ...previous]);
          void navigator.storage?.persist?.().catch(() => undefined);
        }
        if (!activeJob) throw new Error('ไม่พบงานที่บันทึกไว้');
        await resumeCopy(activeJob, account.homeAccountId, graph, google, transferRepository, operation.signal, (state, status) => {
          if (mounted.current) {
            const previous = results.current.get(state.sourceId);
            results.current.set(state.sourceId, { ...state, status });
            if (fileSizes.has(state.sourceId)) {
              // Capture now: the worker mutates its checkpoint again before React may run this updater.
              const bytesDelta = state.bytes - (previous?.bytes ?? 0);
              const doneDelta = Number(state.done) - Number(previous?.done ?? false);
              setProgress(value => ({ bytes: value.bytes + bytesDelta, completed: value.completed + doneDelta }));
            }
            else renderResults(value => value + 1);
          }
        }, value => { if (mounted.current) { setTiming(value); setNow(Date.now()); } });
      });
      if (mounted.current) setPhase('done');
    } catch (error) {
      if (mounted.current) {
        setPhase('paused');
        if (error instanceof GoogleAuthExpired) setSession(null);
        if (!operation.signal.aborted) setError(messageOf(error));
      }
    }
  };
  return <div className="transfer-page">
    <div className="page-header"><div><h1>คัดลอก OneDrive ไป Google Drive</h1><p className="cloud-subtitle">บันทึกความคืบหน้า ทำต่อจากงานเดิมได้โดยไม่สร้างสำเนาซ้ำ</p></div></div>
    {error && <div className="banner banner-error" role="alert">{error}</div>}
    {notice && <div className="banner banner-success" role="status">{notice}</div>}
    {jobs.length > 0 && <div className="cloud-saved-jobs"><label>งานที่บันทึกไว้ <select disabled={busy} value={job?.id ?? ''} onChange={event => { const saved = jobs.find(item => item.id === event.target.value); if (saved) void restore(saved).catch(error => { setPhase('paused'); setError(messageOf(error)); }); }}><option value="" disabled>เลือกงานเดิม</option>{jobs.map(saved => <option value={saved.id} key={saved.id}>{saved.copyName} — {saved.googleEmail}</option>)}</select></label><button type="button" className="btn btn-outline" disabled={busy} onClick={newCopy}>สร้างสำเนารอบใหม่</button></div>}
    {job ? <section className="cloud-job-summary"><div><h3>ต้นทาง</h3><p>{job.source.path}</p></div><div><h3>ปลายทาง</h3><p>{job.target.path} / {job.copyName}</p><p>{job.googleEmail}</p></div></section> : <div className="cloud-pair">
      <section className="cloud-side"><header><h3>OneDrive · ต้นทาง</h3><p>{account?.username}</p></header><CloudFolderBrowser rootName="OneDrive" list={listOneDrive} selected={source} disabled={busy} onSelect={folder => { clearPlan(); setSource(folder); }} /></section>
      <section className="cloud-side"><header><h3>Google Drive · ปลายทาง</h3><p>{session ? googleName : 'เชื่อมต่อบัญชีเพื่อเลือกโฟลเดอร์'}</p></header>{google && <CloudFolderBrowser key={googleName} rootName="My Drive" list={listGoogle} selected={target} disabled={busy} onSelect={folder => { clearPlan(); setTarget(folder); }} />}</section>
    </div>}
    <div className="cloud-actions"><div><p>คัดลอกพร้อมกัน {COPY_CONCURRENCY} ไฟล์ · ไฟล์ละ 8MB ต่อชุด ไม่เก็บเนื้อหาไฟล์ลงเครื่อง</p><p>เปิดหน้านี้ไว้และปิด sleep ของเครื่อง{googleAutoRefresh ? ' · ต่ออายุ Google session อัตโนมัติระหว่างคัดลอก' : ' ถ้า Google session หมดอายุ ให้เชื่อมต่อใหม่แล้วกดทำต่อ'}</p></div><div>
      <button type="button" className="btn btn-outline" disabled={!ready || busy} onClick={() => void connect()}>{phase === 'connecting' ? 'กำลังเชื่อมต่อ…' : session ? 'เชื่อมต่อ Google ใหม่' : 'เชื่อมต่อ Google Drive'}</button>
      {entries && phase !== 'done' && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void testSource()}>ทดสอบอ่านต้นทาง</button>}
      {session?.renew && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void testGoogleRefresh()}>ทดสอบต่ออายุ Google</button>}
      {!job && <button type="button" className="btn btn-outline" disabled={busy || !source || !target} onClick={() => void inspect()}>{phase === 'planning' ? 'กำลังตรวจรายการ…' : 'ตรวจรายการต้นทาง'}</button>}
      <button type="button" className="btn btn-primary" disabled={busy || !entries || !source || !target || !google || phase === 'done'} onClick={() => { if (job) void run(false); else { setCopyName(`${source!.name} - Copy ${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`); setConfirm(true); } }}>{job ? 'ทำต่อจากงานเดิม' : 'เริ่มคัดลอก'}</button>
      {(phase === 'planning' || phase === 'copying') && <button type="button" className="btn btn-outline" onClick={() => controller.current?.abort()}>พักงาน</button>}
    </div></div>
    {!googleConfigured && <p>ตั้งค่า VITE_GOOGLE_CLIENT_ID ตาม README แล้วเปิดแอปใหม่</p>}
    {googleConfigured && !ready && <button type="button" className="btn btn-outline" onClick={loadSdk}>โหลด Google login อีกครั้ง</button>}
    {entries && <section className="cloud-results"><div className="cloud-progress" aria-live="polite"><strong>{phase === 'done' ? 'คัดลอกเสร็จแล้ว' : phase === 'paused' ? 'พักไว้ — ทำต่อได้จากงานเดิม' : phase === 'copying' ? 'กำลังคัดลอก' : 'พร้อมคัดลอก'} · {completed} / {fileSizes.size} ไฟล์</strong><span>{formatBytes(bytes)} / {formatBytes(total)} · {entries.length - fileSizes.size} โฟลเดอร์</span><progress max={total || 1} value={phase === 'done' ? total || 1 : bytes} /></div>
      {job && <div className="cloud-timing">
        <div><span>เวลารวมตั้งแต่สร้างงาน</span><strong>{durationText(metrics?.elapsedMs ?? Math.max(0, now - Date.parse(job.createdAt)))}</strong></div>
        <div><span>เวลาทำงาน</span><strong>{metrics ? durationText(metrics.activeMs) : 'ยังไม่ได้จับเวลา'}</strong></div>
        <div><span>Downtime · พัก/ปิดหน้า/รอเชื่อมต่อ</span><strong>{metrics ? durationText(metrics.downtimeMs) : 'ยังไม่ได้จับเวลา'}</strong></div>
        <div><span>ความเร็วเฉลี่ยขณะทำงาน</span><strong>{metrics?.bytesPerSecond ? `${formatBytes(metrics.bytesPerSecond)}/วินาที` : 'กำลังเก็บข้อมูล…'}</strong></div>
        <div><span>เหลือเวลาโดยประมาณ</span><strong>{phase === 'done' ? 'เสร็จแล้ว' : metrics?.etaMs !== undefined ? durationText(metrics.etaMs) : 'กำลังเก็บข้อมูล…'}</strong></div>
        <div><span>คาดว่าจะเสร็จถ้าคัดลอกต่อเนื่อง</span><strong>{phase === 'done' ? new Date(timing?.finishedAt ?? now).toLocaleString('th-TH') : phase !== 'copying' ? 'พักอยู่ — ทำต่อเพื่อคำนวณ' : metrics?.etaMs !== undefined ? new Date(now + metrics.etaMs).toLocaleString('th-TH') : 'กำลังเก็บข้อมูล…'}</strong></div>
        <p>ประมาณจากทั้งจำนวนไฟล์และข้อมูลที่โอนจริง รวมเวลารอ API{(!metrics || metrics.unknownMs > 1000) && ' · งานเดิมเริ่มจับเวลาทำงาน/Downtime หลังอัปเดตนี้ ย้อนหลังแยกไม่ได้'}</p>
      </div>}
      {outputId && <p className="cloud-output"><a href={`https://drive.google.com/drive/folders/${encodeURIComponent(outputId)}`} target="_blank" rel="noreferrer">เปิดโฟลเดอร์สำเนาใน Google Drive</a></p>}
      <div className="cloud-table-wrap"><table className="table"><thead><tr><th>รายการต้นทาง</th><th>ขนาด</th><th>สถานะ</th></tr></thead><tbody>{visibleEntries.map(entry => <tr key={entry.item.id}><td>{entry.path}{entry.item.folder ? ' /' : ''}</td><td>{entry.item.file ? formatBytes(entry.item.size ?? 0) : 'โฟลเดอร์'}</td><td>{results.current.get(entry.item.id)?.status ?? 'รอคัดลอก'}</td></tr>)}</tbody></table></div>
      <p>กำลังคัดลอกอยู่บนสุด · รายการสำเร็จอยู่ท้ายสุด{entries.length > 500 && ` · แสดง 500 จาก ${entries.length.toLocaleString()} รายการ คัดลอกครบทุกรายการ`}</p>
    </section>}
    <ConfirmDialog open={confirm} title="ยืนยันคัดลอกข้อมูล" confirmLabel="คัดลอกข้อมูล" onCancel={() => setConfirm(false)} onConfirm={() => void run(true)}><p>{source?.path} → {target?.path}</p><p>{fileSizes.size.toLocaleString()} ไฟล์ · {formatBytes(total)}</p><p>สร้างโฟลเดอร์: {copyName}</p></ConfirmDialog>
  </div>;
}
