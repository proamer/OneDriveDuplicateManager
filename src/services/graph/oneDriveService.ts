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

const CHILD_PARAMS =
  '?$top=200' +
  '&$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,image,parentReference' +
  '&$expand=thumbnails($select=medium)';

export function createOneDriveService(client: GraphClient) {
  return {
    getCurrentUser(): Promise<GraphUser> {
      return client.json<GraphUser>('/me?$select=id,displayName,mail,userPrincipalName');
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
  };
}

export type OneDriveService = ReturnType<typeof createOneDriveService>;
