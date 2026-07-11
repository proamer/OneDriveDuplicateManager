import type { GraphClient } from './graphClient';

export interface GraphHashes {
  quickXorHash?: string;
  sha1Hash?: string;
  sha256Hash?: string;
}

export interface GraphThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface GraphThumbnailSet {
  id?: string;
  small?: GraphThumbnail;
  medium?: GraphThumbnail;
  large?: GraphThumbnail;
}

export interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string; hashes?: GraphHashes };
  folder?: { childCount?: number };
  image?: { width?: number; height?: number };
  parentReference?: { driveId?: string; id?: string; path?: string };
  thumbnails?: GraphThumbnailSet[];
}

export interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

// Thumbnails are intentionally NOT expanded here: $expand=thumbnails makes Graph
// generate a preview for every item and is a major throttling/slowdown source on
// large drives. The review page fetches thumbnails lazily for the files it shows.
const CHILD_PARAMS =
  '?$top=200' +
  '&$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,image,parentReference';

export function createOneDriveService(client: GraphClient) {
  return {
    getCurrentUser(): Promise<GraphUser> {
      return client.json<GraphUser>('/me?$select=id,displayName,mail,userPrincipalName');
    },

    /** Total bytes stored in the drive — used to estimate scan progress. */
    async getDriveQuotaUsed(): Promise<number | null> {
      const drive = await client.json<{ quota?: { used?: number } }>('/me/drive?$select=quota');
      const used = drive.quota?.used;
      return typeof used === 'number' && used > 0 ? used : null;
    },

    listDriveRootChildren(signal?: AbortSignal): Promise<GraphPage<GraphDriveItem>> {
      return client.json<GraphPage<GraphDriveItem>>(`/me/drive/root/children${CHILD_PARAMS}`, { signal });
    },

    listDriveItemChildren(itemId: string, signal?: AbortSignal): Promise<GraphPage<GraphDriveItem>> {
      return client.json<GraphPage<GraphDriveItem>>(`/me/drive/items/${itemId}/children${CHILD_PARAMS}`, {
        signal,
      });
    },

    /** Follows an @odata.nextLink returned by one of the list calls. */
    listChildrenPage(nextLink: string, signal?: AbortSignal): Promise<GraphPage<GraphDriveItem>> {
      return client.json<GraphPage<GraphDriveItem>>(nextLink, { signal });
    },

    getDriveItem(itemId: string): Promise<GraphDriveItem> {
      return client.json<GraphDriveItem>(`/me/drive/items/${itemId}`);
    },

    getDriveItemThumbnails(itemId: string): Promise<GraphPage<GraphThumbnailSet>> {
      return client.json<GraphPage<GraphThumbnailSet>>(`/me/drive/items/${itemId}/thumbnails`);
    },

    /** Moves the item to the OneDrive recycle bin (Graph DELETE is a soft delete). */
    async deleteDriveItem(itemId: string): Promise<void> {
      await client.request(`/me/drive/items/${itemId}`, { method: 'DELETE' });
    },

    /**
     * Deletes up to GRAPH_BATCH_LIMIT items in one Graph $batch request instead
     * of one round-trip per file. Returns a per-item outcome so the caller can
     * retry throttled items and record failures. A 404 counts as success (the
     * item is already gone).
     */
    async deleteDriveItemsBatch(itemIds: string[]): Promise<BatchDeleteResult[]> {
      if (itemIds.length === 0) return [];
      const requests = itemIds.map((id, index) => ({
        id: String(index),
        method: 'DELETE',
        url: `/me/drive/items/${id}`,
      }));
      const response = await client.json<{
        responses?: Array<{ id: string; status: number; headers?: Record<string, string>; body?: unknown }>;
      }>('/$batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });

      // Graph does not guarantee response order — match on the request id.
      const byId = new Map((response.responses ?? []).map((entry) => [entry.id, entry]));
      return itemIds.map((itemId, index) => {
        const entry = byId.get(String(index));
        const status = entry?.status ?? 0;
        const ok = (status >= 200 && status < 300) || status === 404;
        const headers = entry?.headers ?? {};
        const retryRaw = headers['Retry-After'] ?? headers['retry-after'];
        const retryAfter = retryRaw ? Number(retryRaw) : undefined;
        let error: string | undefined;
        if (!ok) {
          const body = entry?.body as { error?: { code?: string; message?: string } } | undefined;
          error = body?.error?.message ?? body?.error?.code ?? `HTTP ${status || 'no response'}`;
        }
        return {
          itemId,
          status,
          ok,
          retryAfter: retryAfter !== undefined && Number.isFinite(retryAfter) ? retryAfter : undefined,
          error,
        };
      });
    },
  };
}

/** Microsoft Graph caps a single $batch at 20 sub-requests. */
export const GRAPH_BATCH_LIMIT = 20;

export interface BatchDeleteResult {
  itemId: string;
  status: number;
  /** 2xx or 404 — the item is gone. */
  ok: boolean;
  /** Seconds to wait before retrying, when throttled. */
  retryAfter?: number;
  error?: string;
}

export type OneDriveService = ReturnType<typeof createOneDriveService>;
