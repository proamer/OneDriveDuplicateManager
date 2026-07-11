import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DeleteJob } from './deleteTypes';
import { executeDeleteJobs, removeJob, retryJob } from './deleteService';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { useAuth } from '../auth/useAuth';
import { formatBytes } from '../../utils/formatBytes';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { EmptyState } from '../../components/common/EmptyState';
import { Spinner } from '../../components/common/Spinner';

interface RunSummary {
  deleted: number;
  failed: number;
  bytes: number;
}

export function DeleteQueuePage() {
  const { graph } = useAuth();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<DeleteJob[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setJobs(await deleteJobRepository.getAll());
  }, []);

  useEffect(() => {
    void load();
    // Leaving the page stops the run after the current file — no background deletion.
    return () => abortRef.current?.abort();
  }, [load]);

  const pending = jobs?.filter((job) => job.status === 'pending' || job.status === 'deleting') ?? [];
  const failed = jobs?.filter((job) => job.status === 'failed') ?? [];
  const pendingBytes = pending.reduce((sum, job) => sum + job.size, 0);

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setLastRun(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const summary: RunSummary = { deleted: 0, failed: 0, bytes: 0 };

    await executeDeleteJobs(graph, pending, controller.signal, {
      onJobUpdate: (job) => {
        if (job.status === 'deleted') {
          summary.deleted++;
          summary.bytes += job.size;
        } else if (job.status === 'failed') {
          summary.failed++;
        }
        setJobs((previous) => previous?.map((p) => (p.id === job.id ? job : p)) ?? null);
      },
    });

    abortRef.current = null;
    setRunning(false);
    setLastRun(summary);
    await load();
  };

  const stop = () => abortRef.current?.abort();

  const handleRetry = async (id: string) => {
    await retryJob(id);
    await load();
  };

  const handleRetryAll = async () => {
    for (const job of failed) await retryJob(job.id);
    await load();
  };

  const handleRemove = async (id: string) => {
    await removeJob(id);
    await load();
  };

  if (jobs === null) {
    return (
      <div className="page-loading">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Delete Queue</h1>
          <p className="page-subtitle">
            Files are moved to the OneDrive recycle bin — you can restore them from OneDrive afterwards.
          </p>
        </div>
        {pending.length > 0 && (
          <div className="page-actions">
            {running ? (
              <button type="button" className="btn btn-outline" onClick={stop}>
                Stop after current batch
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmOpen(true)}>
                Delete {pending.length.toLocaleString()} file{pending.length === 1 ? '' : 's'} (
                {formatBytes(pendingBytes)})
              </button>
            )}
          </div>
        )}
      </div>

      {lastRun && (
        <div className={`banner ${lastRun.failed > 0 ? 'banner-warn' : 'banner-success'}`}>
          <span>
            Moved {lastRun.deleted.toLocaleString()} file{lastRun.deleted === 1 ? '' : 's'} (
            {formatBytes(lastRun.bytes)}) to the OneDrive recycle bin.
            {lastRun.failed > 0 && ` ${lastRun.failed.toLocaleString()} failed — see below.`}
          </span>
        </div>
      )}

      {pending.length === 0 && failed.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Delete queue is empty"
            description="Mark duplicate files for deletion in the review screen, then confirm and run the deletion here."
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/review')}>
                Go to Duplicate Review
              </button>
            }
          />
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3>Pending ({pending.length.toLocaleString()})</h3>
                {running && (
                  <span className="running-hint">
                    <Spinner size={14} /> Deleting — keep this page open.
                  </span>
                )}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Folder</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((job) => (
                    <tr key={job.id}>
                      <td className="truncate" title={job.name}>
                        {job.name}
                      </td>
                      <td className="mono truncate" title={job.path}>
                        {job.path}
                      </td>
                      <td>{formatBytes(job.size)}</td>
                      <td>
                        {job.status === 'deleting' ? (
                          <span className="badge badge-blue">Deleting…</span>
                        ) : (
                          <span className="badge badge-gray">Pending</span>
                        )}
                      </td>
                      <td className="col-row-action">
                        {job.status === 'pending' && !running && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleRemove(job.id)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {failed.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3>Failed ({failed.length.toLocaleString()})</h3>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void handleRetryAll()}>
                  Retry all
                </button>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Error</th>
                    <th>Size</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {failed.map((job) => (
                    <tr key={job.id}>
                      <td className="truncate" title={job.name}>
                        {job.name}
                      </td>
                      <td className="error-text truncate" title={job.error ?? ''}>
                        {job.error}
                      </td>
                      <td>{formatBytes(job.size)}</td>
                      <td className="col-row-action">
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => void handleRetry(job.id)}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void handleRemove(job.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Move files to the OneDrive recycle bin?"
        confirmLabel={`Delete ${pending.length.toLocaleString()} file${pending.length === 1 ? '' : 's'}`}
        tone="danger"
        onConfirm={() => void run()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          <strong>{pending.length.toLocaleString()}</strong> file{pending.length === 1 ? '' : 's'} ·{' '}
          <strong>{formatBytes(pendingBytes)}</strong> will be moved to the OneDrive recycle bin. Nothing is
          deleted permanently — you can restore files from OneDrive.
        </p>
        <ul className="dialog-file-list mono">
          {pending.map((job) => (
            <li key={job.id} title={`${job.path}/${job.name}`}>
              {job.path === '/' ? '' : job.path}/{job.name}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}
