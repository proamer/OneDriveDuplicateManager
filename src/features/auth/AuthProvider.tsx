import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BrowserAuthError,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import { isMsalConfigured, loginScopes, msalConfig } from './msalConfig';
import { createGraphClient, type TokenSource } from '../../services/graph/graphClient';
import { createOneDriveService, type OneDriveService } from '../../services/graph/oneDriveService';
import { messageOf } from '../../utils/errorMessage';

export type AuthStatus = 'initializing' | 'unauthenticated' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  account: AccountInfo | null;
  configured: boolean;
  error: string | null;
  login(): Promise<void>;
  logout(): Promise<void>;
  /** Silent first; interactive popup only when MSAL requires interaction. */
  getAccessToken(forceRefresh?: boolean): Promise<string | null>;
  graph: OneDriveService;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

const pca = new PublicClientApplication(msalConfig);

// Popup sign-in breaks when the browser blocks the window or the popup never
// hands its hash back (common on mobile). These codes mean "retry as a
// full-page redirect", not "the user's sign-in failed".
const popupUnusableCodes = new Set([
  'popup_window_error',
  'empty_window_error',
  'monitor_window_timeout',
  'hash_empty_error',
  'hash_does_not_contain_known_properties',
]);

function isPopupUnusableError(e: unknown): boolean {
  return e instanceof BrowserAuthError && popupUnusableCodes.has(e.errorCode);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accountRef = useRef<AccountInfo | null>(null);
  accountRef.current = account;

  useEffect(() => {
    if (!isMsalConfigured) {
      setStatus('unauthenticated');
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        await pca.initialize();
        const redirectResult = await pca.handleRedirectPromise();
        const existing = redirectResult?.account ?? pca.getAllAccounts()[0] ?? null;
        if (existing) pca.setActiveAccount(existing);
        if (!disposed) {
          setAccount(existing);
          setStatus(existing ? 'authenticated' : 'unauthenticated');
        }
      } catch (e) {
        if (!disposed) {
          setError(messageOf(e));
          setStatus('unauthenticated');
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const getAccessToken = useCallback(async (forceRefresh = false): Promise<string | null> => {
    const current = accountRef.current ?? pca.getAllAccounts()[0];
    if (!current) return null;
    try {
      const result = await pca.acquireTokenSilent({ scopes: loginScopes, account: current, forceRefresh });
      return result.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        const result = await pca.acquireTokenPopup({ scopes: loginScopes, account: current });
        return result.accessToken;
      }
      throw e;
    }
  }, []);

  const login = useCallback(async () => {
    setError(null);
    try {
      const result = await pca.loginPopup({ scopes: loginScopes, prompt: 'select_account' });
      pca.setActiveAccount(result.account);
      setAccount(result.account);
      setStatus('authenticated');
    } catch (e) {
      if (isPopupUnusableError(e)) {
        try {
          await pca.loginRedirect({ scopes: loginScopes, prompt: 'select_account' });
          return;
        } catch (redirectError) {
          setError(messageOf(redirectError));
          return;
        }
      }
      setError(messageOf(e));
    }
  }, []);

  const logout = useCallback(async () => {
    const current = accountRef.current;
    setAccount(null);
    setStatus('unauthenticated');
    try {
      await pca.logoutPopup(current ? { account: current } : undefined);
    } catch {
      // Popup closed by the user — local state is already cleared.
    }
  }, []);

  const graph = useMemo(() => {
    const tokens: TokenSource = {
      get: () => getAccessToken(),
      refresh: () => getAccessToken(true),
    };
    return createOneDriveService(createGraphClient(tokens));
  }, [getAccessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, account, configured: isMsalConfigured, error, login, logout, getAccessToken, graph }),
    [status, account, error, login, logout, getAccessToken, graph],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
