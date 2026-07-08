import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { msalClientId } from '../auth/msalConfig';
import { scannerService } from '../scanner/scannerService';
import type { GraphUser } from '../../services/graph/oneDriveService';
import { STORE, clearAllData, dbCount } from '../../services/db/indexedDb';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { formatBytes } from '../../utils/formatBytes';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';

interface StorageStats {
  files: number;
  groups: number;
  jobs: number;
  ignored: number;
  usageBytes: number | null;
}

export function SettingsPage() {
  const { account, graph, logout } = useAuth();
  const navigate = useNavigate();
  const [user, setUser] = useState<GraphUser | null>(null);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    const [files, groups, jobs, ignored] = await Promise.all([
      dbCount(STORE.files),
      dbCount(STORE.duplicateGroups),
      dbCount(STORE.deleteJobs),
      dbCount(STORE.ignoreList),
    ]);
    let usageBytes: number | null = null;
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage ?? null;
    } catch {
      // storage.estimate unsupported — leave unknown.
    }
    setStats({ files, groups, jobs, ignored, usageBytes });
  }, []);

  useEffect(() => {
    void loadStats();
    void graph
      .getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null));
  }, [graph, loadStats]);

  const clearIgnored = async () => {
    const restored = await duplicateRepository.clearIgnoreList();
    setNotice(`Ignore list cleared — ${restored} group${restored === 1 ? '' : 's'} returned to review.`);
    await loadStats();
  };

  const clearEverything = async () => {
    setClearing(true);
    try {
      await clearAllData();
      scannerService.reset();
      navigate('/');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const scannerBusy = scannerService.isBusy();

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      {notice && <div className="banner banner-success">{notice}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Connected account</h3>
        </div>
        <div className="card-body settings-rows">
          <div className="settings-row">
            <span className="settings-label">Name</span>
            <span>{user?.displayName ?? account?.name ?? '—'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Account</span>
            <span>{user?.mail ?? user?.userPrincipalName ?? account?.username ?? '—'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">App client id</span>
            <span className="mono">
              {msalClientId ? `${msalClientId.slice(0, 8)}…${msalClientId.slice(-4)}` : 'not configured'}
            </span>
          </div>
          <div className="settings-row">
            <span></span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Local data</h3>
        </div>
        <div className="card-body settings-rows">
          <div className="settings-row">
            <span className="settings-label">Indexed files</span>
            <span>{stats?.files.toLocaleString() ?? '—'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Duplicate groups</span>
            <span>{stats?.groups.toLocaleString() ?? '—'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Delete jobs</span>
            <span>{stats?.jobs.toLocaleString() ?? '—'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Browser storage used</span>
            <span>{stats?.usageBytes != null ? formatBytes(stats.usageBytes) : 'unknown'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Ignored groups</span>
            <span className="settings-inline">
              {stats?.ignored.toLocaleString() ?? '—'}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void clearIgnored()}
                disabled={!stats || stats.ignored === 0}
              >
                Clear ignore list
              </button>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Reset</span>
            <span className="settings-inline">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmClear(true)}
                disabled={scannerBusy}
                title={scannerBusy ? 'Wait for the running scan to finish' : undefined}
              >
                Clear all local data
              </button>
              <span className="settings-hint">
                Removes the local cache only — nothing in OneDrive is touched. A new scan will be required.
              </span>
            </span>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all local data?"
        confirmLabel="Clear local data"
        tone="danger"
        busy={clearing}
        onConfirm={() => void clearEverything()}
        onCancel={() => setConfirmClear(false)}
      >
        <p>
          This removes the local scan cache, duplicate groups, delete history and ignore list from this
          browser. Your OneDrive files are not affected. You stay signed in.
        </p>
      </ConfirmDialog>
    </>
  );
}
