import type { FileRecord } from '../scanner/scanTypes';
import { recommendKeepFile } from '../../utils/fileScore';
import type { DuplicateGroup, DuplicateGroupItem, HashKind } from './duplicateTypes';

export interface GroupingInput {
  files: FileRecord[];
  scanSessionId: string;
  /** Existing groups keyed by group id — user choices (keep file, marks) are preserved. */
  previousGroups: Map<string, DuplicateGroup>;
  previousItems: Map<string, DuplicateGroupItem>;
  ignoredKeys: Set<string>;
}

export interface GroupingResult {
  groups: DuplicateGroup[];
  items: DuplicateGroupItem[];
  /** Redundant files across pending groups (files beyond the keep file). */
  duplicateFiles: number;
  wastedBytes: number;
}

/** Strongest available hash. Returns null when the file has no hash — such files are never classified as duplicates. */
export function strongHashOf(file: FileRecord): { kind: HashKind; value: string } | null {
  if (file.sha256Hash) return { kind: 'sha256', value: file.sha256Hash };
  if (file.sha1Hash) return { kind: 'sha1', value: file.sha1Hash };
  if (file.quickXorHash) return { kind: 'quickXor', value: file.quickXorHash };
  return null;
}

interface Bucket {
  files: FileRecord[];
  kind: HashKind;
  value: string;
  size: number;
}

/** Pure exact-duplicate grouping: same size + same strong hash. */
export function buildDuplicateGroups(input: GroupingInput): GroupingResult {
  const buckets = new Map<string, Bucket>();
  for (const file of input.files) {
    if (file.status === 'deleted' || file.size <= 0) continue;
    const hash = strongHashOf(file);
    if (!hash) continue;
    const key = `${file.size}:${hash.kind}:${hash.value}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.files.push(file);
    } else {
      buckets.set(key, { files: [file], kind: hash.kind, value: hash.value, size: file.size });
    }
  }

  const now = new Date().toISOString();
  const groups: DuplicateGroup[] = [];
  const items: DuplicateGroupItem[] = [];
  let duplicateFiles = 0;
  let totalWasted = 0;

  for (const [key, bucket] of buckets) {
    if (bucket.files.length < 2) continue;

    const previous = input.previousGroups.get(key);
    const previousKeepStillPresent =
      previous?.keepIsUserChoice === true && bucket.files.some((file) => file.id === previous.keepFileId);
    const keepFileId = previousKeepStillPresent ? previous.keepFileId : recommendKeepFile(bucket.files).id;
    const keepFile = bucket.files.find((file) => file.id === keepFileId) ?? bucket.files[0];

    const totalBytes = bucket.files.reduce((sum, file) => sum + file.size, 0);
    const wastedBytes = totalBytes - keepFile.size;
    const status = input.ignoredKeys.has(key) ? ('ignored' as const) : ('pending' as const);

    groups.push({
      id: key,
      scanSessionId: input.scanSessionId,
      hashKind: bucket.kind,
      hashValue: bucket.value,
      size: bucket.size,
      confidence: bucket.kind === 'quickXor' ? 95 : 100,
      fileCount: bucket.files.length,
      totalBytes,
      wastedBytes,
      keepFileId,
      keepIsUserChoice: previousKeepStillPresent,
      status,
      createdAt: previous?.createdAt ?? now,
    });

    for (const file of bucket.files) {
      const itemId = `${key}|${file.id}`;
      const previousItem = input.previousItems.get(itemId);
      items.push({
        id: itemId,
        groupId: key,
        fileId: file.id,
        markedForDelete:
          status === 'pending' && file.id !== keepFileId && (previousItem?.markedForDelete ?? false),
      });
    }

    if (status === 'pending') {
      duplicateFiles += bucket.files.length - 1;
      totalWasted += wastedBytes;
    }
  }

  return { groups, items, duplicateFiles, wastedBytes: totalWasted };
}
