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

export type ScanWorkerRequest =
  | { type: 'start'; sessionId: string; accessToken: string }
  | { type: 'cancel' }
  | { type: 'token'; requestId: number; accessToken: string | null };

export type ScanWorkerResponse =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'needToken'; requestId: number }
  | { type: 'done'; session: ScanSession }
  | { type: 'error'; error: string };
