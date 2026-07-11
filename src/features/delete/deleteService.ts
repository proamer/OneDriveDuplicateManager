import type { DeleteJob } from './deleteTypes';
import type { FileRecord } from '../scanner/scanTypes';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { fileRepository } from '../../services/db/fileRepository';
import { STORE, dbBulkPut } from '../../services/db/indexedDb';
import { GraphError } from '../../services/graph/graphClient';
import type { OneDriveService } from '../../services/graph/oneDriveService';
import { messageOf } from '../../utils/errorMessage';

/**
 * Turns every marked review item into a pending delete job. Keep files are never
 * queued. Reads and writes in bulk so queueing thousands of files stays fast.
 */
export async function queueMarkedFiles(): Promise<{ queued: number; skipped: number }> {
  const marked = await duplicateRepository.getMarkedItems();
  if (marked.length === 0) return { queued: 0, skipped: 0 };

  const groups = new Map((await duplicateRepository.getAllGroups()).map((group) => [group.id, group]));
  const files = new Map(
    (await fileRepository.getMany(marked.map((item) => item.fileId))).map((file) => [file.id, file]),
  );
  const existingJobs = new Map((await deleteJobRepository.getAll()).map((job) => [job.id, job]));

  const now = new Date().toISOString();
  const newJobs: DeleteJob[] = [];
  const filesToQueue: FileRecord[] = [];
  let queued = 0;
  let skipped = 0;

  for (const item of marked) {
    const group = groups.get(item.groupId);
    const file = files.get(item.fileId);
    if (!group || !file || group.status !== 'pending' || file.status === 'deleted') {
      skipped++;
      continue;
    }
    if (group.keepFileId === item.fileId) {
      skipped++;
      continue;
    }
    const existing = existingJobs.get(item.fileId);
    if (existing && (existing.status === 'pending' || existing.status === 'deleting')) {
      skipped++;
      continue;
    }

    newJobs.push({
      id: file.id,
      fileId: file.id,
      driveId: file.driveId,
      itemId: file.itemId,
      name: file.name,
      path: file.path,
      size: file.size,
      groupId: group.id,
      status: 'pending',
      error: null,
      createdAt: now,
      finishedAt: null,
    });
    filesToQueue.push({ ...file, status: 'queued' });
    queued++;
  }

  await dbBulkPut(STORE.deleteJobs, newJobs);
  await dbBulkPut(STORE.files, filesToQueue);
  return { queued, skipped };
}

export interface ExecuteCallbacks {
  onJobUpdate(job: DeleteJob): void;
}

/**
 * Deletes jobs sequentially via Microsoft Graph (soft delete → OneDrive recycle bin).
 * Safety guards re-checked per job right before the API call:
 * never the keep file, never the last remaining file of a group.
 */
export async function executeDeleteJobs(
  graph: OneDriveService,
  jobs: DeleteJob[],
  signal: AbortSignal,
  callbacks: ExecuteCallbacks,
): Promise<void> {
  for (const job of jobs) {
    if (signal.aborted) return;

    const group = await duplicateRepository.getGroup(job.groupId);
    if (group && group.keepFileId === job.fileId) {
      await failJob(job, 'Refused: this is the file selected to keep.', callbacks);
      continue;
    }
    if (group) {
      const remaining = await duplicateRepository.getItems(group.id);
      if (remaining.length <= 1) {
        await failJob(job, 'Refused: at least one file must remain in the group.', callbacks);
        continue;
      }
    }

    const deleting: DeleteJob = { ...job, status: 'deleting', error: null };
    await deleteJobRepository.put(deleting);
    callbacks.onJobUpdate(deleting);

    try {
      try {
        await graph.deleteDriveItem(job.itemId);
      } catch (e) {
        // Already gone in OneDrive → treat as deleted.
        if (!(e instanceof GraphError && e.status === 404)) throw e;
      }
      const done: DeleteJob = { ...deleting, status: 'deleted', finishedAt: new Date().toISOString() };
      await deleteJobRepository.put(done);
      await fileRepository.setStatus(job.fileId, 'deleted');
      await duplicateRepository.removeFileFromGroups(job.fileId, job.size);
      callbacks.onJobUpdate(done);
    } catch (e) {
      await failJob(job, messageOf(e), callbacks);
    }
  }
}

async function failJob(job: DeleteJob, error: string, callbacks: ExecuteCallbacks): Promise<void> {
  const failed: DeleteJob = { ...job, status: 'failed', error, finishedAt: new Date().toISOString() };
  await deleteJobRepository.put(failed);
  callbacks.onJobUpdate(failed);
}

export async function retryJob(id: string): Promise<void> {
  const job = await deleteJobRepository.get(id);
  if (job?.status === 'failed') {
    await deleteJobRepository.put({ ...job, status: 'pending', error: null, finishedAt: null });
  }
}

/** Removes a pending/failed job from the queue and releases the file back to review. */
export async function removeJob(id: string): Promise<void> {
  const job = await deleteJobRepository.get(id);
  if (!job || job.status === 'deleting') return;
  if (job.status !== 'deleted') {
    const file = await fileRepository.get(job.fileId);
    if (file && file.status === 'queued') await fileRepository.setStatus(file.id, 'active');
  }
  await deleteJobRepository.remove(id);
}
