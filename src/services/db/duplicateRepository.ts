import type {
  DuplicateGroup,
  DuplicateGroupItem,
  GroupStatus,
  IgnoreEntry,
} from '../../features/duplicates/duplicateTypes';
import {
  STORE,
  dbBulkPut,
  dbClear,
  dbDelete,
  dbGet,
  dbGetAll,
  dbGetAllByIndex,
  dbPut,
} from './indexedDb';
import { fileRepository } from './fileRepository';

export const duplicateRepository = {
  async replaceAll(groups: DuplicateGroup[], items: DuplicateGroupItem[]): Promise<void> {
    await dbClear(STORE.duplicateGroups);
    await dbClear(STORE.duplicateGroupItems);
    await dbBulkPut(STORE.duplicateGroups, groups);
    await dbBulkPut(STORE.duplicateGroupItems, items);
  },

  getAllGroups(): Promise<DuplicateGroup[]> {
    return dbGetAll<DuplicateGroup>(STORE.duplicateGroups);
  },

  async getGroups(status: GroupStatus): Promise<DuplicateGroup[]> {
    const groups = await dbGetAll<DuplicateGroup>(STORE.duplicateGroups);
    return groups.filter((group) => group.status === status).sort((a, b) => b.wastedBytes - a.wastedBytes);
  },

  getGroup(id: string): Promise<DuplicateGroup | undefined> {
    return dbGet<DuplicateGroup>(STORE.duplicateGroups, id);
  },

  getAllItems(): Promise<DuplicateGroupItem[]> {
    return dbGetAll<DuplicateGroupItem>(STORE.duplicateGroupItems);
  },

  getItems(groupId: string): Promise<DuplicateGroupItem[]> {
    return dbGetAllByIndex<DuplicateGroupItem>(STORE.duplicateGroupItems, 'byGroup', groupId);
  },

  async setKeepFile(groupId: string, fileId: string): Promise<void> {
    const group = await dbGet<DuplicateGroup>(STORE.duplicateGroups, groupId);
    if (!group) return;
    const keepFile = await fileRepository.get(fileId);
    const items = await duplicateRepository.getItems(groupId);
    // The keep file can never stay marked for deletion.
    const updatedItems = items
      .filter((item) => item.fileId === fileId && item.markedForDelete)
      .map((item) => ({ ...item, markedForDelete: false }));
    await dbBulkPut(STORE.duplicateGroupItems, updatedItems);
    await dbPut(STORE.duplicateGroups, {
      ...group,
      keepFileId: fileId,
      keepIsUserChoice: true,
      wastedBytes: keepFile ? Math.max(0, group.totalBytes - keepFile.size) : group.wastedBytes,
    });
  },

  async setMarked(groupId: string, fileId: string, marked: boolean): Promise<void> {
    const group = await dbGet<DuplicateGroup>(STORE.duplicateGroups, groupId);
    if (!group) return;
    if (marked && group.keepFileId === fileId) {
      throw new Error('The file selected to keep cannot be marked for deletion.');
    }
    const item = await dbGet<DuplicateGroupItem>(STORE.duplicateGroupItems, `${groupId}|${fileId}`);
    if (item) await dbPut(STORE.duplicateGroupItems, { ...item, markedForDelete: marked });
  },

  /** Marks every deletable file in the group except the keep file. Skips queued/deleted files. */
  async markAllExceptKeep(groupId: string): Promise<void> {
    const group = await dbGet<DuplicateGroup>(STORE.duplicateGroups, groupId);
    if (!group) return;
    const items = await duplicateRepository.getItems(groupId);
    const files = await fileRepository.getMany(items.map((item) => item.fileId));
    const activeIds = new Set(files.filter((file) => file.status === 'active').map((file) => file.id));
    const updated = items.map((item) => ({
      ...item,
      markedForDelete: item.fileId !== group.keepFileId && activeIds.has(item.fileId),
    }));
    await dbBulkPut(STORE.duplicateGroupItems, updated);
  },

  async ignoreGroup(groupId: string): Promise<void> {
    const group = await dbGet<DuplicateGroup>(STORE.duplicateGroups, groupId);
    if (!group) return;
    await dbPut(STORE.ignoreList, {
      groupKey: groupId,
      createdAt: new Date().toISOString(),
    } satisfies IgnoreEntry);
    const items = await duplicateRepository.getItems(groupId);
    await dbBulkPut(
      STORE.duplicateGroupItems,
      items.map((item) => ({ ...item, markedForDelete: false })),
    );
    await dbPut(STORE.duplicateGroups, { ...group, status: 'ignored' as const });
  },

  getIgnoreEntries(): Promise<IgnoreEntry[]> {
    return dbGetAll<IgnoreEntry>(STORE.ignoreList);
  },

  /** Clears the ignore list and returns previously ignored groups to review. */
  async clearIgnoreList(): Promise<number> {
    await dbClear(STORE.ignoreList);
    const groups = await dbGetAll<DuplicateGroup>(STORE.duplicateGroups);
    const restored = groups
      .filter((group) => group.status === 'ignored')
      .map((group) => ({ ...group, status: 'pending' as const }));
    await dbBulkPut(STORE.duplicateGroups, restored);
    return restored.length;
  },

  async getMarkedItems(): Promise<DuplicateGroupItem[]> {
    const items = await dbGetAll<DuplicateGroupItem>(STORE.duplicateGroupItems);
    return items.filter((item) => item.markedForDelete);
  },

  async getMarkedSummary(): Promise<{ count: number; bytes: number }> {
    const marked = await duplicateRepository.getMarkedItems();
    const files = await fileRepository.getMany(marked.map((item) => item.fileId));
    return { count: marked.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  },

  /** Called after a file was deleted: removes it from its group and resolves the group if done. */
  async removeFileFromGroups(fileId: string, fileSize: number): Promise<void> {
    const items = await dbGetAllByIndex<DuplicateGroupItem>(STORE.duplicateGroupItems, 'byFile', fileId);
    for (const item of items) {
      await dbDelete(STORE.duplicateGroupItems, item.id);
      const group = await dbGet<DuplicateGroup>(STORE.duplicateGroups, item.groupId);
      if (!group) continue;
      const remaining = await duplicateRepository.getItems(group.id);
      const next: DuplicateGroup = {
        ...group,
        fileCount: remaining.length,
        totalBytes: Math.max(0, group.totalBytes - fileSize),
        wastedBytes: Math.max(0, group.wastedBytes - fileSize),
      };
      if (next.keepFileId === fileId && remaining.length > 0) {
        next.keepFileId = remaining[0].fileId;
      }
      if (remaining.length <= 1) {
        next.status = 'resolved';
        next.wastedBytes = 0;
      }
      await dbPut(STORE.duplicateGroups, next);
    }
  },
};
