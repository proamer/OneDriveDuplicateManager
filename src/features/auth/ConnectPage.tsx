import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';
import { MicrosoftLogo } from '../../components/common/Icon';
import { FullPageSpinner } from '../../components/common/Spinner';

export function ConnectPage() {
  const { status, configured, login, error } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  if (status === 'initializing') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/" replace />;

  const handleLogin = async () => {
    setSigningIn(true);
    try {
      await login();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="connect-shell">
      <div className="connect-card">
        <div className="connect-brand">
          <span className="brand-mark large" aria-hidden="true" />
          <h1>OneDrive Duplicate Cleaner</h1>
        </div>
        <p className="connect-lede">
          Find and clean up duplicate photos in your OneDrive — entirely in your browser. No server, no
          uploads, no automatic deletion.
        </p>
        <ul className="connect-points">
          <li>Scans image metadata and file hashes only — photos are never downloaded.</li>
          <li>You review every duplicate group before anything happens.</li>
          <li>Removed files go to the OneDrive recycle bin, never deleted permanently.</li>
        </ul>

        {configured ? (
          <button
            type="button"
            className="btn btn-primary btn-lg ms-signin"
            onClick={() => void handleLogin()}
            disabled={signingIn}
          >
            <MicrosoftLogo />
            {signingIn ? 'Waiting for Microsoft…' : 'Sign in with Microsoft'}
          </button>
        ) : (
          <div className="banner banner-warn config-warning">
            <strong>Setup required.</strong>
            <p>
              No Azure App Registration client id configured. Create <code>.env.local</code> with:
            </p>
            <pre className="mono">VITE_MSAL_CLIENT_ID=&lt;your-client-id&gt;</pre>
            <p>
              See <code>README.md</code> for the step-by-step Azure setup, then restart{' '}
              <code>npm run dev</code>.
            </p>
          </div>
        )}

        {error && <div className="banner banner-error">{error}</div>}

        <p className="connect-footnote">
          Scan results are cached locally in your browser (IndexedDB) and never leave this device.
        </p>
      </div>
    </div>
  );
}
