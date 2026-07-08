export function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

export type FolderClass = 'preferred' | 'neutral' | 'suspect';

const PREFERRED_PATTERNS = [/\/pictures(\/|$)/i, /\/camera roll(\/|$)/i];
const SUSPECT_PATTERNS = [/duplicate/i, /\bcopy\b/i, /\bcopies\b/i, /download/i, /\btemp\b/i, /\btmp\b/i];

/** Classifies a folder path for keep-file recommendation. Suspect wins over preferred. */
export function folderClass(path: string): FolderClass {
  if (SUSPECT_PATTERNS.some((pattern) => pattern.test(path))) return 'suspect';
  if (PREFERRED_PATTERNS.some((pattern) => pattern.test(path))) return 'preferred';
  return 'neutral';
}
