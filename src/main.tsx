import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';

// The MSAL login popup redirects back to this same app. Rendering the router in
// the popup would rewrite the URL and wipe the auth response hash before the
// opener window reads it (hash_empty_error), so leave the popup blank — the
// opener picks up the hash and closes it.
const isMsalPopupCallback =
  window.opener != null &&
  window.opener !== window &&
  (window.name.startsWith('msal.') || /[#&](code|error)=/.test(window.location.hash));

if (!isMsalPopupCallback) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
