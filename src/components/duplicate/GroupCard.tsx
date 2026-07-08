import { useEffect, useState } from 'react';
import type { DuplicateGroup, DuplicateGroupItem } from '../../features/duplicates/duplicateTypes';
import type { FileRecord } from '../../features/scanner/scanTypes';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { fileRepository } from '../../services/db/fileRepository';
import { compareKeepPriority } from '../../utils/fileScore';
import { formatBytes } from '../../utils/formatBytes';
import { formatDate } from '../../utils/formatDate';
import { FileThumb } from '../file/FileThumb';
import { Icon } from '../common/Icon';
import { Spinner } from '../common/Spinner';

interface GroupCardProps {
  group: DuplicateGroup;
  /** Called after any mark/keep change so the parent can refresh the selection summary. */
  onMutate: () => void;
  /** Called when the group leaves the pending list (ignored). */
  onRemoved: () => void;
}

const HASH_LABEL = { sha256: 'SHA-256', sha1: 'SHA-1', quickXor: 'QuickXor' } as const;

export function GroupCard({ group: initialGroup, onMutate, onRemoved }: GroupCardProps) {
  const [group, setGroup] = useState(initialGroup);
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [items, setItems] = useState<DuplicateGroupItem[] | null>(null);
  const [keepPreview, setKeepPreview] = useState<FileRecord | null>(null);

  useEffect(() => {
    let disposed = false;
    void fileRepository.get(group.keepFileId).then((file) => {
      if (!disposed) setKeepPreview(file ?? null);
    });
    return () => {
      disposed = true;
    };
  }, [group.keepFileId]);

  const loadDetail = async () => {
    const groupItems = await duplicateRepository.getItems(group.id);
    const groupFiles = await fileRepository.getMany(groupItems.map((item) => item.fileId));
    groupFiles.sort(compareKeepPriority);
    setItems(groupItems);
    setFiles(groupFiles);
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && files === null) void loadDetail();
  };

  const chooseKeep = async (fileId: string) => {
    await duplicateRepository.setKeepFile(group.id, fileId);
    const updated = await duplicateRepository.getGroup(group.id);
    if (updated) setGroup(updated);
    await loadDetail();
    onMutate();
  };

  const toggleMark = async (fileId: string, marked: boolean) => {
    await duplicateRepository.setMarked(group.id, fileId, marked);
    setItems(
      (previous) =>
        previous?.map((item) => (item.fileId === fileId ? { ...item, markedForDelete: marked } : item)) ??
        null,
    );
    onMutate();
  };

  const selectAllExceptKeep = async () => {
    await duplicateRepository.markAllExceptKeep(group.id);
    await loadDetail();
    onMutate();
  };

  const ignoreGroup = async () => {
    await duplicateRepository.ignoreGroup(group.id);
    onMutate();
    onRemoved();
  };

  const markedByFile = new Map(items?.map((item) => [item.fileId, item.markedForDelete]) ?? []);

  return (
    <section className="group-card">
      <button type="button" className="group-summary" onClick={toggleExpanded} aria-expanded={expanded}>
        {keepPreview ? (
          <FileThumb file={keepPreview} size={48} />
        ) : (
          <span className="thumb thumb-placeholder" style={{ width: 48, height: 48 }}>
            <Icon name="image" />
          </span>
        )}
        <div className="group-summary-main">
          <div className="group-summary-title">
            <strong>{keepPreview?.name ?? group.hashValue.slice(0, 16)}</strong>
            <span className={`badge ${group.confidence === 100 ? 'badge-green' : 'badge-blue'}`}>
              {group.confidence}% match
            </span>
            <span className="badge badge-gray">{HASH_LABEL[group.hashKind]}</span>
          </div>
          <div className="group-summary-sub">
            {group.fileCount} copies · {formatBytes(group.size)} each ·{' '}
            <span className="wasted">{formatBytes(group.wastedBytes)} recoverable</span>
          </div>
        </div>
        <span className={`chevron${expanded ? ' open' : ''}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="group-detail">
          {files === null || items === null ? (
            <div className="group-loading">
              <Spinner />
            </div>
          ) : (
            <>
              <table className="table file-table">
                <thead>
                  <tr>
                    <th className="col-keep">Keep</th>
                    <th></th>
                    <th>File</th>
                    <th>Size</th>
                    <th>Resolution</th>
                    <th>Created</th>
                    <th>Modified</th>
                    <th className="col-delete">Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => {
                    const isKeep = file.id === group.keepFileId;
                    const isMarked = markedByFile.get(file.id) ?? false;
                    const locked = file.status !== 'active';
                    return (
                      <tr key={file.id} className={isKeep ? 'row-keep' : isMarked ? 'row-marked' : ''}>
                        <td className="col-keep">
                          <input
                            type="radio"
                            name={`keep-${group.id}`}
                            checked={isKeep}
                            onChange={() => void chooseKeep(file.id)}
                            disabled={locked}
                            title="Keep this file"
                          />
                        </td>
                        <td>
                          <FileThumb file={file} size={44} />
                        </td>
                        <td className="file-cell">
                          <div className="file-name">
                            <span className="truncate" title={file.name}>
                              {file.name}
                            </span>
                            {isKeep && <span className="badge badge-green">Keep</span>}
                            {file.status === 'queued' && <span className="badge badge-amber">Queued</span>}
                            {file.status === 'deleted' && <span className="badge badge-gray">Deleted</span>}
                            {file.webUrl && (
                              <a
                                href={file.webUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="icon-link"
                                title="Open in OneDrive"
                              >
                                <Icon name="external" size={14} />
                              </a>
                            )}
                          </div>
                          <div className="file-path mono truncate" title={file.path}>
                            {file.path}
                          </div>
                        </td>
                        <td>{formatBytes(file.size)}</td>
                        <td>{file.width && file.height ? `${file.width}×${file.height}` : '—'}</td>
                        <td>{formatDate(file.createdDateTime)}</td>
                        <td>{formatDate(file.lastModifiedDateTime)}</td>
                        <td className="col-delete">
                          <input
                            type="checkbox"
                            checked={isMarked}
                            onChange={(event) => void toggleMark(file.id, event.target.checked)}
                            disabled={isKeep || locked}
                            title={isKeep ? 'The keep file cannot be deleted' : 'Mark for deletion'}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="group-actions">
                <span className="hash-info mono" title={`${HASH_LABEL[group.hashKind]}: ${group.hashValue}`}>
                  {HASH_LABEL[group.hashKind]} {group.hashValue.slice(0, 20)}…
                </span>
                <div className="group-actions-buttons">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => void selectAllExceptKeep()}>
                    Select all except keep
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void ignoreGroup()}>
                    Ignore this group
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
