import type { FileRecord } from '../features/scanner/scanTypes';
import { folderClass } from './pathUtils';

const FOLDER_RANK = { preferred: 2, neutral: 1, suspect: 0 } as const;

/**
 * Ranks which file to keep in a duplicate group:
 * resolution → size → folder quality → older creation date.
 * Folder quality is checked before creation date because exact duplicates
 * always tie on resolution and size, so the folder rule would otherwise never apply.
 */
export function compareKeepPriority(a: FileRecord, b: FileRecord): number {
  const resolutionA = (a.width ?? 0) * (a.height ?? 0);
  const resolutionB = (b.width ?? 0) * (b.height ?? 0);
  if (resolutionA !== resolutionB) return resolutionB - resolutionA;
  if (a.size !== b.size) return b.size - a.size;
  const folderA = FOLDER_RANK[folderClass(a.path)];
  const folderB = FOLDER_RANK[folderClass(b.path)];
  if (folderA !== folderB) return folderB - folderA;
  const createdA = Date.parse(a.createdDateTime) || 0;
  const createdB = Date.parse(b.createdDateTime) || 0;
  if (createdA !== createdB) return createdA - createdB;
  return a.id.localeCompare(b.id);
}

export function recommendKeepFile(files: FileRecord[]): FileRecord {
  if (files.length === 0) throw new Error('recommendKeepFile requires at least one file');
  return [...files].sort(compareKeepPriority)[0];
}
