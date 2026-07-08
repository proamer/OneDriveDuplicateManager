export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * Abstraction over token acquisition so the same client works on the main
 * thread (MSAL) and inside Web Workers (postMessage bridge to the main thread).
 */
export interface TokenSource {
  get(): Promise<string | null>;
  refresh(): Promise<string | null>;
}

export interface GraphClientOptions {
  /** Called when Graph throttles us (429/503) before waiting `seconds`. */
  onThrottle?: (seconds: number) => void;
}

export interface GraphClient {
  request(pathOrUrl: string, init?: RequestInit): Promise<Response>;
  json<T>(pathOrUrl: string, init?: RequestInit): Promise<T>;
}

const MAX_ATTEMPTS = 6;

export function createGraphClient(tokens: TokenSource, options: GraphClientOptions = {}): GraphClient {
  async function request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    let token = await tokens.get();
    let refreshed = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!token) {
        if (refreshed) throw new GraphError(401, 'Not signed in. Sign in and try again.');
        refreshed = true;
        token = await tokens.refresh();
        continue;
      }

      const response = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await tokens.refresh();
        continue;
      }

      if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(2 ** attempt * 2, 30);
        options.onThrottle?.(seconds);
        await sleep(seconds * 1000, init.signal ?? undefined);
        continue;
      }

      if (!response.ok) throw new GraphError(response.status, await readGraphError(response));
      return response;
    }

    throw new GraphError(429, 'Microsoft Graph keeps throttling requests. Wait a bit and try again.');
  }

  async function json<T>(pathOrUrl: string, init?: RequestInit): Promise<T> {
    const response = await request(pathOrUrl, init);
    return (await response.json()) as T;
  }

  return { request, json };
}

async function readGraphError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const error = body.error;
    if (error) return `${error.code ?? response.status}: ${error.message ?? 'Request failed'}`;
  } catch {
    // Non-JSON error body — fall through.
  }
  return `HTTP ${response.status}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}
