import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { scannerService, useScannerState } from './scannerService';
import type { ScanFrontierFolder, ScanSession } from './scanTypes';
import { FolderPicker } from './FolderPicker';
import { scanSessionRepository } from '../../services/db/scanSessionRepository';
import { formatBytes } from '../../utils/formatBytes';
import { formatDateTime, formatDuration, formatEta } from '../../utils/formatDate';
import { ErrorBanner } from '../../components/common/ErrorBanner';
import { Spinner } from '../../components/common/Spinner';

export function ScanPage() {
  const { getAccessToken } = useAuth();
  const scanner = useScannerState();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [lastSession, setLastSession] = useState<ScanSession | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<Map<string, ScanFrontierFolder>>(new Map());
  const autostarted = useRef(false);

  const startFresh = () => void scannerService.start(getAccessToken, { resume: false });
  const resumeScan = () => void scannerService.start(getAccessToken, { resume: true });
  const startSelected = () =>
    void scannerService.start(getAccessToken, { resume: false, roots: [...selectedFolders.values()] });

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const canResume = await scannerService.checkResumable();
      if (disposed) return;
      if (searchParams.get('autostart') === '1' && !autostarted.current) {
        autostarted.current = true;
        setSearchParams({}, { replace: true });
        const phase = scannerService.getState().phase;
        // Don't auto-start a fresh scan over a resumable one — let the user choose.
        if (!canResume && (phase === 'idle' || phase === 'completed')) startFresh();
      }
    })();
    return () => {
      disposed = true;
    };
    // Mount-only: autostart must fire once, not on every phase change.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scanner.phase === 'idle' || scanner.phase === 'completed') {
      void scanSessionRepository.getLastFinished().then((session) => setLastSession(session ?? null));
    }
  }, [scanner.phase]);

  // Progress estimate. Preferred: bytes walked vs. the drive's total used bytes
  // (full-drive scans). Fallback: completed folders vs. the known frontier —
  // rough, since undiscovered subfolders aren't counted yet. Capped at 99%
  // because only the walk itself knows when it is truly done.
  const { bytesSeen, estimatedTotalBytes, foldersScanned, foldersPending } = scanner.progress;
  let scanPercent: number | null = null;
  if (estimatedTotalBytes !== null && estimatedTotalBytes > 0) {
    scanPercent = Math.min(99, Math.floor((bytesSeen / estimatedTotalBytes) * 100));
  } else if (foldersScanned + foldersPending > 0) {
    scanPercent = Math.min(99, Math.floor((foldersScanned / (foldersScanned + foldersPending)) * 100));
  }

  // ETA from the scan rate over a sliding window (throttling makes the
  // instantaneous rate spiky, so average across the last few minutes).
  const rateSamples = useRef<Array<{ at: number; bytes: number; folders: number }>>([]);
  if (scanner.phase !== 'scanning') {
    rateSamples.current = [];
  } else {
    const now = Date.now();
    const samples = rateSamples.current;
    const last = samples[samples.length - 1];
    // At most one sample per second keeps the window small under rapid updates.
    if (!last || now - last.at >= 1000 || bytesSeen < last.bytes) {
      if (last && bytesSeen < last.bytes) samples.length = 0; // new/restarted scan
      samples.push({ at: now, bytes: bytesSeen, folders: foldersScanned });
      rateSamples.current = samples.filter((sample) => now - sample.at <= 180_000);
    }
  }

  let etaSeconds: number | null = null;
  const samples = rateSamples.current;
  if (scanner.phase === 'scanning' && samples.length >= 2) {
    const first = samples[0];
    const latest = samples[samples.length - 1];
    const elapsed = (latest.at - first.at) / 1000;
    if (elapsed >= 15) {
      if (estimatedTotalBytes !== null && estimatedTotalBytes > 0) {
        const rate = (latest.bytes - first.bytes) / elapsed;
        if (rate > 0) etaSeconds = Math.max(0, (estimatedTotalBytes - bytesSeen) / rate);
      } else {
        const rate = (latest.folders - first.folders) / elapsed;
        if (rate > 0) etaSeconds = foldersPending / rate;
      }
    }
  }
  const etaText = etaSeconds !== null ? formatEta(etaSeconds) : '';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Scan</h1>
          <p className="page-subtitle">
            Walks your OneDrive folder tree and indexes file metadata — nothing is downloaded or changed.
          </p>
        </div>
      </div>

      {scanner.resumable && scanner.phase !== 'scanning' && scanner.phase !== 'grouping' && (
        <div className="banner banner-warn resume-banner">
          <span>
            A previous scan was interrupted after{' '}
            <strong>{(scanner.resumeInfo?.imagesFound ?? 0).toLocaleString()}</strong> files across{' '}
            {(scanner.resumeInfo?.foldersScanned ?? 0).toLocaleString()} folders. Resume to continue where it
            left off instead of starting over.
          </span>
          <div className="resume-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={resumeScan}>
              Resume scan
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={startFresh}>
              Start over
            </button>
          </div>
        </div>
      )}

      {scanner.phase === 'idle' && (
        <div className="card">
          <div className="card-body scan-idle">
            <h3>Ready to scan</h3>
            <p>
              The scan collects name, path, size and file hashes for every file, then finds exact duplicates
              by size + hash. You can cancel at any time; partial results are kept and the scan can be resumed
              later.
            </p>
            <div className="scan-start-actions">
              <button type="button" className="btn btn-primary" onClick={startFresh}>
                Scan entire OneDrive
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setPickerOpen((open) => !open)}
                aria-expanded={pickerOpen}
              >
                {pickerOpen ? 'Hide folder selection' : 'Choose folders…'}
              </button>
            </div>

            {pickerOpen && (
              <div className="folder-picker">
                <p className="folder-picker-hint">
                  Pick one or more folders to scan. Checking a folder includes everything inside it. Results
                  from folders scanned earlier are kept, and duplicates are matched across all indexed files.
                </p>
                <FolderPicker selected={selectedFolders} onChange={setSelectedFolders} />
                <div className="folder-picker-footer">
                  <span className="folder-picker-count">
                    {selectedFolders.size === 0
                      ? 'No folders selected'
                      : `${selectedFolders.size.toLocaleString()} folder${selectedFolders.size === 1 ? '' : 's'} selected`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={startSelected}
                    disabled={selectedFolders.size === 0}
                  >
                    Scan selected folders
                  </button>
                </div>
              </div>
            )}

            {lastSession && (
              <p className="scan-last">
                Last scan: {formatDateTime(lastSession.finishedAt ?? lastSession.startedAt)} ·{' '}
                {lastSession.filesScanned.toLocaleString()} files · {lastSession.status}
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
              {scanner.phase === 'scanning' && scanPercent !== null && (
                <span className="scan-percent">
                  ~{scanPercent}%
                  {etaText && <span className="scan-eta"> · ~{etaText} left</span>}
                </span>
              )}
            </div>
            {scanner.phase === 'scanning' && scanPercent !== null ? (
              <>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${scanPercent}%` }} />
                </div>
                <p className="scan-progress-note">
                  {scanner.progress.estimatedTotalBytes !== null
                    ? `${formatBytes(scanner.progress.bytesSeen)} of ~${formatBytes(scanner.progress.estimatedTotalBytes)} scanned — estimated from your OneDrive storage usage.`
                    : `${scanner.progress.foldersScanned.toLocaleString()} folders done, ${scanner.progress.foldersPending.toLocaleString()} discovered folders remaining — rough estimate, more folders may be found.`}
                </p>
              </>
            ) : (
              <div className="progress-indeterminate" aria-hidden="true" />
            )}
            <div className="scan-stats">
              <div>
                <span className="stat-label">Items seen</span>
                <span className="stat-value-sm">{scanner.progress.itemsSeen.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Files indexed</span>
                <span className="stat-value-sm">{scanner.progress.imagesFound.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Folders scanned</span>
                <span className="stat-value-sm">{scanner.progress.foldersScanned.toLocaleString()}</span>
              </div>
              <div>
                <span className="stat-label">Data scanned</span>
                <span className="stat-value-sm">{formatBytes(scanner.progress.bytesSeen)}</span>
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
                <span className="stat-label">Files indexed</span>
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
              <button type="button" className="btn btn-outline" onClick={startFresh}>
                Scan Again
              </button>
            </div>
          </div>
        </div>
      )}

      {scanner.phase === 'error' && (
        <div className="card">
          <div className="card-body">
            {/* When resumable, the banner above offers Resume / Start over instead. */}
            <ErrorBanner
              message={scanner.error ?? 'Scan failed.'}
              onRetry={scanner.resumable ? undefined : startFresh}
              retryLabel="Try again"
            />
          </div>
        </div>
      )}
    </>
  );
}
