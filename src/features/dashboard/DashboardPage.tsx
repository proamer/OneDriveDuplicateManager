import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ScanSession } from '../scanner/scanTypes';
import { useScannerState } from '../scanner/scannerService';
import { scanSessionRepository } from '../../services/db/scanSessionRepository';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { formatBytes } from '../../utils/formatBytes';
import { formatDateTime } from '../../utils/formatDate';
import { EmptyState } from '../../components/common/EmptyState';
import { Spinner } from '../../components/common/Spinner';

interface DashboardData {
  session: ScanSession | null;
  groupCount: number;
  duplicateFiles: number;
  wastedBytes: number;
  pendingDeletes: number;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const scanner = useScannerState();
  const [data, setData] = useState<DashboardData | null>(null);

  const load = useCallback(async () => {
    const [session, groups, jobs] = await Promise.all([
      scanSessionRepository.getLastFinished(),
      duplicateRepository.getGroups('pending'),
      deleteJobRepository.getAll(),
    ]);
    setData({
      session: session ?? null,
      groupCount: groups.length,
      duplicateFiles: groups.reduce((sum, group) => sum + group.fileCount - 1, 0),
      wastedBytes: groups.reduce((sum, group) => sum + group.wastedBytes, 0),
      pendingDeletes: jobs.filter((job) => job.status === 'pending').length,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load, scanner.phase]);

  if (data === null) {
    return (
      <div className="page-loading">
        <Spinner size={24} />
      </div>
    );
  }

  const busy = scanner.phase === 'scanning' || scanner.phase === 'grouping';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          {data.session && (
            <p className="page-subtitle">
              Last scan {formatDateTime(data.session.finishedAt ?? data.session.startedAt)}
              {data.session.status === 'cancelled' && ' (cancelled — partial results)'}
              {data.session.status === 'failed' && ' (failed)'}
            </p>
          )}
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => navigate('/review')}
            disabled={data.groupCount === 0}
          >
            Review Duplicates
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate(busy ? '/scan' : '/scan?autostart=1')}
          >
            {busy ? 'View Running Scan' : 'Start Scan'}
          </button>
        </div>
      </div>

      {busy && (
        <div className="banner banner-info">
          <Spinner size={14} />
          <span>
            {scanner.phase === 'scanning'
              ? `Scan in progress — ${scanner.progress.imagesFound.toLocaleString()} images found so far.`
              : 'Scan finished — analyzing duplicates…'}
          </span>
          <Link to="/scan" className="banner-link">
            View progress
          </Link>
        </div>
      )}

      {data.pendingDeletes > 0 && (
        <div className="banner banner-warn">
          <span>
            {data.pendingDeletes.toLocaleString()} file{data.pendingDeletes === 1 ? '' : 's'} waiting in the
            delete queue.
          </span>
          <Link to="/queue" className="banner-link">
            Open queue
          </Link>
        </div>
      )}

      {data.session ? (
        <div className="stat-grid">
          <div className="stat card">
            <span className="stat-label">Scanned images</span>
            <span className="stat-value">{data.session.filesScanned.toLocaleString()}</span>
            <span className="stat-sub">{formatBytes(data.session.totalBytes)} across your OneDrive</span>
          </div>
          <div className="stat card">
            <span className="stat-label">Duplicate groups</span>
            <span className="stat-value">{data.groupCount.toLocaleString()}</span>
            <span className="stat-sub">exact matches awaiting review</span>
          </div>
          <div className="stat card">
            <span className="stat-label">Duplicate files</span>
            <span className="stat-value">{data.duplicateFiles.toLocaleString()}</span>
            <span className="stat-sub">redundant copies beyond the keep file</span>
          </div>
          <div className="stat card">
            <span className="stat-label">Potential savings</span>
            <span className="stat-value">{formatBytes(data.wastedBytes)}</span>
            <span className="stat-sub">recoverable by cleaning duplicates</span>
          </div>
        </div>
      ) : (
        !busy && (
          <div className="card">
            <EmptyState
              title="No scan yet"
              description="Run your first scan to index the photos in your OneDrive and find exact duplicates. The scan reads metadata only — no photos are downloaded."
              action={
                <button type="button" className="btn btn-primary" onClick={() => navigate('/scan?autostart=1')}>
                  Start first scan
                </button>
              }
            />
          </div>
        )
      )}

      {data.session && data.groupCount === 0 && !busy && (
        <div className="card">
          <EmptyState
            title="No duplicates found"
            description="Your last scan found no exact duplicate images. Nice and tidy."
            action={
              <button type="button" className="btn btn-outline" onClick={() => navigate('/scan?autostart=1')}>
                Scan again
              </button>
            }
          />
        </div>
      )}
    </>
  );
}
