import { useEffect, useState } from 'react';
import type { ScanSession } from '../scanner/scanTypes';
import type { DeleteJob } from '../delete/deleteTypes';
import { scanSessionRepository } from '../../services/db/scanSessionRepository';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { formatBytes } from '../../utils/formatBytes';
import { formatDateTime, formatDuration } from '../../utils/formatDate';
import { EmptyState } from '../../components/common/EmptyState';
import { Spinner } from '../../components/common/Spinner';

const SESSION_BADGE: Record<ScanSession['status'], string> = {
  completed: 'badge-green',
  running: 'badge-blue',
  cancelled: 'badge-amber',
  failed: 'badge-red',
};

export function HistoryPage() {
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [jobs, setJobs] = useState<DeleteJob[] | null>(null);

  useEffect(() => {
    void scanSessionRepository.getAll().then(setSessions);
    void deleteJobRepository
      .getAll()
      .then((all) => setJobs(all.filter((job) => job.status === 'deleted' || job.status === 'failed')));
  }, []);

  if (sessions === null || jobs === null) {
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
          <h1>History</h1>
          <p className="page-subtitle">Past scans and deletions on this browser.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Scan sessions</h3>
        </div>
        {sessions.length === 0 ? (
          <EmptyState title="No scans yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Images</th>
                <th>Folders</th>
                <th>Data scanned</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{formatDateTime(session.startedAt)}</td>
                  <td>
                    <span className={`badge ${SESSION_BADGE[session.status]}`}>{session.status}</span>
                  </td>
                  <td>{session.filesScanned.toLocaleString()}</td>
                  <td>{session.foldersScanned.toLocaleString()}</td>
                  <td>{formatBytes(session.totalBytes)}</td>
                  <td>{formatDuration(session.startedAt, session.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Deletions</h3>
        </div>
        {jobs.length === 0 ? (
          <EmptyState title="No deletions yet" description="Files you delete are listed here with their outcome." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Finished</th>
                <th>File</th>
                <th>Folder</th>
                <th>Size</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{formatDateTime(job.finishedAt)}</td>
                  <td className="truncate" title={job.name}>
                    {job.name}
                  </td>
                  <td className="mono truncate" title={job.path}>
                    {job.path}
                  </td>
                  <td>{formatBytes(job.size)}</td>
                  <td>
                    <span className={`badge ${job.status === 'deleted' ? 'badge-green' : 'badge-red'}`}>
                      {job.status === 'deleted' ? 'Recycled' : 'Failed'}
                    </span>
                  </td>
                  <td className="error-text truncate" title={job.error ?? ''}>
                    {job.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
