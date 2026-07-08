import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { scannerService, useScannerState } from './scannerService';
import type { ScanSession } from './scanTypes';
import { scanSessionRepository } from '../../services/db/scanSessionRepository';
import { formatBytes } from '../../utils/formatBytes';
import { formatDateTime, formatDuration } from '../../utils/formatDate';
import { ErrorBanner } from '../../components/common/ErrorBanner';
import { Spinner } from '../../components/common/Spinner';

export function ScanPage() {
  const { getAccessToken } = useAuth();
  const scanner = useScannerState();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [lastSession, setLastSession] = useState<ScanSession | null>(null);
  const autostarted = useRef(false);

  const start = () => void scannerService.start(getAccessToken);

  useEffect(() => {
    if (searchParams.get('autostart') === '1' && !autostarted.current) {
      autostarted.current = true;
      setSearchParams({}, { replace: true });
      if (scanner.phase === 'idle' || scanner.phase === 'completed') start();
    }
    // Mount-only: autostart must fire once, not on every phase change.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scanner.phase === 'idle' || scanner.phase === 'completed') {
      void scanSessionRepository.getLastFinished().then((session) => setLastSession(session ?? null));
    }
  }, [scanner.phase]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Scan</h1>
          <p className="page-subtitle">
            Walks your OneDrive folder tree and indexes image metadata — nothing is downloaded or changed.
          </p>
        </div>
      </div>

      {scanner.phase === 'idle' && (
        <div className="card">
          <div className="card-body scan-idle">
            <h3>Ready to scan</h3>
            <p>
              The scan collects name, path, size, hashes and thumbnails for JPEG, PNG, WebP and HEIC/HEIF
              files, then finds exact duplicates by size + file hash. You can cancel at any time; partial
              results are kept.
            </p>
            <button type="button" className="btn btn-primary" onClick={start}>
              Start Scan
            </button>
            {lastSession && (
              <p className="scan-last">
                Last scan: {formatDateTime(lastSession.finishedAt ?? lastSession.startedAt)} ·{' '}
                {lastSession.filesScanned.toLocaleString()} images · {lastSession.status}
              </p>
            )}
          </div>
        </div>
      )}

      {(scanner.phase === 'scanning' || scanner.phase === 'grouping') && (
        <div className="card">
          <div className="card-body">
            <div className="scan-running-header">
              <Spinner />
              <h3>{scanner.phase === 'scanning' ? 'Scanning OneDrive…' : 'Analyzing duplicates…'}</h3>
            </div>
            <div className="progress-indeterminate" aria-hidden="true" />
            <div className="scan-stats">
              <div>
                <span className="stat-label">Items seen</span>
                <span className="stat-value-sm">{scanner.progress.itemsSeen.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Images found</span>
                <span className="stat-value-sm">{scanner.progress.imagesFound.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Folders scanned</span>
                <span className="stat-value-sm">{scanner.progress.foldersScanned.toLocaleString()}</span>
              </div>
            </div>
            {scanner.progress.currentPath && (
              <p className="scan-current mono truncate" title={scanner.progress.currentPath}>
                {scanner.progress.currentPath}
              </p>
            )}
            {scanner.progress.message && <p className="scan-message">{scanner.progress.message}</p>}
            {scanner.phase === 'scanning' && (
              <div className="scan-actions">
                <button type="button" className="btn btn-outline" onClick={() => scannerService.cancel()}>
                  Cancel Scan
                </button>
                <span className="scan-hint">Keep this browser tab open while scanning.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {scanner.phase === 'completed' && scanner.session && (
        <div className="card">
          <div className="card-body">
            <h3>
              {scanner.session.status === 'cancelled' ? 'Scan cancelled — partial results kept' : 'Scan complete'}
            </h3>
            <div className="scan-stats">
              <div>
                <span className="stat-label">Images indexed</span>
                <span className="stat-value-sm">{scanner.session.filesScanned.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Duplicate groups</span>
                <span className="stat-value-sm">{scanner.groupsFound.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Duplicate files</span>
                <span className="stat-value-sm">{scanner.duplicateFiles.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Recoverable</span>
                <span className="stat-value-sm">{formatBytes(scanner.wastedBytes)}</span>
              </div>
              <div>
                <span className="stat-label">Duration</span>
                <span className="stat-value-sm">
                  {formatDuration(scanner.session.startedAt, scanner.session.finishedAt)}
                </span>
              </div>
            </div>
            <div className="scan-actions">
              {scanner.groupsFound > 0 ? (
                <button type="button" className="btn btn-primary" onClick={() => navigate('/review')}>
                  Review {scanner.groupsFound.toLocaleString()} duplicate group
                  {scanner.groupsFound === 1 ? '' : 's'}
                </button>
              ) : (
                <p className="scan-clean">No exact duplicates found. Your library is clean.</p>
              )}
              <button type="button" className="btn btn-outline" onClick={start}>
                Scan Again
              </button>
            </div>
          </div>
        </div>
      )}

      {scanner.phase === 'error' && (
        <div className="card">
          <div className="card-body">
            <ErrorBanner message={scanner.error ?? 'Scan failed.'} onRetry={start} retryLabel="Try again" />
          </div>
        </div>
      )}
    </>
  );
}
