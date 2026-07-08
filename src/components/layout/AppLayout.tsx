import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../features/auth/useAuth';
import { useScannerState } from '../../features/scanner/scannerService';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { Icon, type IconName } from '../common/Icon';
import { Spinner } from '../common/Spinner';

const NAV_ITEMS: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/scan', label: 'Scan', icon: 'scan' },
  { to: '/review', label: 'Duplicate Review', icon: 'copies' },
  { to: '/queue', label: 'Delete Queue', icon: 'trash' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function AppLayout() {
  const { account, logout } = useAuth();
  const scanner = useScannerState();
  const location = useLocation();
  const [pendingDeletes, setPendingDeletes] = useState(0);

  useEffect(() => {
    let disposed = false;
    void deleteJobRepository.getAll().then((jobs) => {
      if (!disposed) setPendingDeletes(jobs.filter((job) => job.status === 'pending').length);
    });
    return () => {
      disposed = true;
    };
  }, [location.pathname]);

  const name = account?.name ?? account?.username ?? 'Account';
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong>Duplicate Cleaner</strong>
            <span>for OneDrive</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.to === '/queue' && pendingDeletes > 0 && (
                <span className="nav-badge">{pendingDeletes}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          Deletions go to the OneDrive recycle bin — nothing is removed permanently.
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-status">
            {(scanner.phase === 'scanning' || scanner.phase === 'grouping') && (
              <NavLink to="/scan" className="scan-indicator">
                <Spinner size={14} />
                <span>
                  {scanner.phase === 'scanning'
                    ? `Scanning… ${scanner.progress.imagesFound.toLocaleString()} images`
                    : 'Analyzing duplicates…'}
                </span>
              </NavLink>
            )}
          </div>
          <div className="topbar-account">
            <span className="avatar" aria-hidden="true">
              {initials || 'U'}
            </span>
            <div className="account-meta">
              <strong>{account?.name ?? 'Signed in'}</strong>
              <span>{account?.username ?? ''}</span>
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
