import { useEffect, useState } from 'react';
import type { DriveFolder } from '../../services/google/googleDrive';
import { messageOf } from '../../utils/errorMessage';
export interface FolderChoice { id: string; name: string; path: string }
export function CloudFolderBrowser({ rootName, list, selected, onSelect, disabled }: {
  rootName: string; list: (id: string, signal: AbortSignal) => Promise<DriveFolder[]>;
  selected: FolderChoice | null; onSelect(folder: FolderChoice): void; disabled: boolean;
}) {
  const [trail, setTrail] = useState<DriveFolder[]>([{ id: 'root', name: rootName }]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const current = trail[trail.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setFolders([]);
    void list(current.id, controller.signal).then(setFolders).catch(error => {
      if (!controller.signal.aborted) setError(messageOf(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [current.id, list, retry]);
  return <div className="cloud-browser">
    <nav className="cloud-breadcrumb" aria-label={`${rootName} folder path`}>
      {trail.map((folder, index) => <button className="btn btn-outline btn-sm" type="button" key={folder.id} disabled={disabled || index === trail.length - 1} onClick={() => setTrail(trail.slice(0, index + 1))}>{folder.name}</button>)}
    </nav>
    <div className="cloud-folder-list" aria-busy={loading}>
      {loading ? <p>กำลังโหลดโฟลเดอร์…</p> : error ? <div role="alert"><p>{error}</p><button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={() => setRetry(value => value + 1)}>ลองใหม่</button></div> : folders.length === 0 ? <p>ไม่มีโฟลเดอร์ย่อย</p> : folders.map(folder => <button type="button" className="cloud-folder-item" key={folder.id} disabled={disabled} onClick={() => setTrail([...trail, folder])}><span aria-hidden="true">▸</span><span>{folder.name}</span></button>)}
    </div>
    <button type="button" className="btn btn-outline" disabled={disabled || loading || Boolean(error)} onClick={() => onSelect({ ...current, path: trail.map(folder => folder.name).join(' / ') })}>เลือกโฟลเดอร์นี้</button>
    <p className="cloud-selection">{selected ? selected.path : 'ยังไม่ได้เลือกโฟลเดอร์'}</p>
  </div>;
}
