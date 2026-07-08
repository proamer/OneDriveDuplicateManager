import type { Configuration } from '@azure/msal-browser';

export const msalClientId = import.meta.env.VITE_MSAL_CLIENT_ID ?? '';

/** False until VITE_MSAL_CLIENT_ID is set — the Connect page shows setup steps instead of a broken login. */
export const isMsalConfigured = msalClientId.length > 0 && !msalClientId.startsWith('00000000');

export const msalConfig: Configuration = {
  auth: {
    clientId: msalClientId,
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    // Tokens live only inside MSAL's own cache. localStorage keeps sign-in across reloads.
    cacheLocation: 'localStorage',
  },
};

// MSAL adds openid, profile and offline_access automatically.
export const loginScopes = ['User.Read', 'Files.ReadWrite'];
