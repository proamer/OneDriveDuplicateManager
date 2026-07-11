export type FileStatus = 'active' | 'queued' | 'deleted';

export interface FileRecord {
  /** OneDrive item id — this app works against a single drive (/me/drive). */
  id: string;
  driveId: string;
  itemId: string;
  name: string;
  /** Parent folder path, e.g. "/Pictures/2024". "/" for the drive root. */
  path: string;
  size: number;
  mimeType: string;
  quickXorHash: string | null;
  sha1Hash: string | null;
  sha256Hash: string | null;
  width: number | null;
  height: number | null;
  createdDateTime: string;
  lastModifiedDateTime: string;
  thumbnailUrl: string | null;
  webUrl: string | null;
  scanSessionId: string;
  status: FileStatus;
}

export type ScanSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface ScanSession {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScanSessionStatus;
  itemsSeen: number;
  /** Image files stored for this session. */
  filesScanned: number;
  foldersScanned: number;
  /** Total bytes of all image files found. */
  totalBytes: number;
  error: string | null;
}

export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export interface ScanProgress {
  itemsSeen: number;
  imagesFound: number;
  foldersScanned: number;
  currentPath: string;
  message: string;
}

/** A pending folder in the breadth-first walk. `itemId: null` is the drive root. */
export interface ScanFrontierFolder {
  itemId: string | null;
  path: string;
}

/**
 * Persisted walk state so an interrupted scan can resume instead of restarting.
 * Saved after each folder completes; the queue head is always processed next.
 */
export interface ScanCheckpoint {
  sessionId: string;
  queue: ScanFrontierFolder[];
  /** Folder paths this scan is limited to; null = entire drive. Needed on resume. */
  scopePaths: string[] | null;
  itemsSeen: number;
  imagesFound: number;
  foldersScanned: number;
  totalBytes: number;
  updatedAt: string;
}

export type ScanWorkerRequest =
  | {
      type: 'start';
      sessionId: string;
      resume: boolean;
      /** Folders to scan; null/empty = entire drive from the root. */
      roots: ScanFrontierFolder[] | null;
      accessToken: string;
    }
  | { type: 'cancel' }
  | { type: 'token'; requestId: number; accessToken: string | null };

export type ScanWorkerResponse =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'needToken'; requestId: number }
  | { type: 'done'; session: ScanSession }
  | { type: 'error'; error: string };
