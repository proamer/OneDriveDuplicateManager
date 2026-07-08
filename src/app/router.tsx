import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../features/auth/useAuth';
import { ConnectPage } from '../features/auth/ConnectPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { ScanPage } from '../features/scanner/ScanPage';
import { DuplicateReviewPage } from '../features/duplicates/DuplicateReviewPage';
import { DeleteQueuePage } from '../features/delete/DeleteQueuePage';
import { HistoryPage } from '../features/history/HistoryPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppLayout } from '../components/layout/AppLayout';
import { FullPageSpinner } from '../components/common/Spinner';

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'initializing') return <FullPageSpinner />;
  if (status === 'unauthenticated') return <Navigate to="/connect" replace />;
  return children;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/connect" element={<ConnectPage />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/review" element={<DuplicateReviewPage />} />
          <Route path="/queue" element={<DeleteQueuePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
