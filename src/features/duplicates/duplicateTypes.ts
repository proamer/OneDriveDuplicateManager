export type GroupStatus = 'pending' | 'ignored' | 'resolved';
export type HashKind = 'sha256' | 'sha1' | 'quickXor';

export interface DuplicateGroup {
  /** Stable group key: `${size}:${hashKind}:${hashValue}`. Survives rescans. */
  id: string;
  scanSessionId: string;
  hashKind: HashKind;
  hashValue: string;
  size: number;
  /** 100 = same size + strong hash (sha1/sha256), 95 = same size + quickXorHash. */
  confidence: 95 | 100;
  fileCount: number;
  totalBytes: number;
  wastedBytes: number;
  keepFileId: string;
  /** true when the user picked the keep file (preserved across rescans). */
  keepIsUserChoice: boolean;
  status: GroupStatus;
  createdAt: string;
}

export interface DuplicateGroupItem {
  /** `${groupId}|${fileId}` */
  id: string;
  groupId: string;
  fileId: string;
  markedForDelete: boolean;
}

export interface IgnoreEntry {
  /** Same value as DuplicateGroup.id — ignoring survives rescans. */
  groupKey: string;
  createdAt: string;
}

export type DuplicateWorkerRequest = { type: 'group'; scanSessionId: string };

export type DuplicateWorkerResponse =
  | { type: 'progress'; processed: number; total: number; groupsFound: number; message: string }
  | { type: 'done'; groupsFound: number; duplicateFiles: number; wastedBytes: number }
  | { type: 'error'; error: string };
