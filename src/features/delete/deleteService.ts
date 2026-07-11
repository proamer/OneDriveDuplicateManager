import type { DeleteJob } from './deleteTypes';
import type { FileRecord } from '../scanner/scanTypes';
import { deleteJobRepository } from '../../services/db/deleteJobRepository';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { fileRepository } from '../../services/db/fileRepository';
import { STORE, dbBulkPut } from '../../services/db/indexedDb';
import {
  GRAPH_BATCH_LIMIT,
  type BatchDeleteResult,
  type OneDriveService,
} from '../../services/graph/oneDriveService';
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

/** Requeue a throttled item at most this many times before giving up on it. */
const MAX_THROTTLE_RETRIES = 8;

/**
 * Deletes jobs via Microsoft Graph $batch (soft delete → OneDrive recycle bin),
 * up to GRAPH_BATCH_LIMIT files per request instead of one round-trip each.
 * Throttled items are requeued (respecting Retry-After); the keep file of a group
 * is never deleted. Group bookkeeping is done once at the end in bulk.
 */
export async function executeDeleteJobs(
  graph: OneDriveService,
  jobs: DeleteJob[],
  signal: AbortSignal,
  callbacks: ExecuteCallbacks,
): Promise<void> {
  const groups = new Map((await duplicateRepository.getAllGroups()).map((group) => [group.id, group]));
  let queue = jobs.filter((job) => job.status === 'pending' || job.status === 'deleting');
  const deletedFileIds: string[] = [];
  const attempts = new Map<string, number>();

  while (queue.length > 0 && !signal.aborted) {
    const chunk = queue.slice(0, GRAPH_BATCH_LIMIT);
    queue = queue.slice(GRAPH_BATCH_LIMIT);

    // Guard: never delete the file chosen to keep in a group.
    const safe: DeleteJob[] = [];
    for (const job of chunk) {
      const group = groups.get(job.groupId);
      if (group && group.keepFileId === job.fileId) {
        await failJob(job, 'Refused: this is the file selected to keep.', callbacks);
        continue;
      }
      safe.push(job);
    }
    if (safe.length === 0) continue;

    const deletingJobs = safe.map((job) => ({ ...job, status: 'deleting' as const, error: null }));
    await dbBulkPut(STORE.deleteJobs, deletingJobs);
    for (const job of deletingJobs) callbacks.onJobUpdate(job);

    let results: BatchDeleteResult[];
    try {
      results = await graph.deleteDriveItemsBatch(safe.map((job) => job.itemId));
    } catch (e) {
      if (signal.aborted) return;
      for (const job of safe) await failJob(job, messageOf(e), callbacks);
      continue;
    }
    const byItem = new Map(results.map((result) => [result.itemId, result]));

    const now = new Date().toISOString();
    const doneJobs: DeleteJob[] = [];
    const failedJobs: DeleteJob[] = [];
    const retryJobs: DeleteJob[] = [];
    let waitSeconds = 0;

    for (const job of safe) {
      const result = byItem.get(job.itemId);
      const throttled =
        !result || result.status === 429 || result.status === 503 || result.status === 504 || result.status === 0;

      if (result?.ok) {
        doneJobs.push({ ...job, status: 'deleted', error: null, finishedAt: now });
        deletedFileIds.push(job.fileId);
      } else if (throttled) {
        const tries = (attempts.get(job.id) ?? 0) + 1;
        attempts.set(job.id, tries);
        if (tries >= MAX_THROTTLE_RETRIES) {
          failedJobs.push({
            ...job,
            status: 'failed',
            error: 'Throttled repeatedly by OneDrive — try again later.',
            finishedAt: now,
          });
        } else {
          waitSeconds = Math.max(waitSeconds, result?.retryAfter ?? 5);
          retryJobs.push({ ...job, status: 'pending', error: null });
        }
      } else {
        failedJobs.push({ ...job, status: 'failed', error: result.error ?? `HTTP ${result.status}`, finishedAt: now });
      }
    }

    if (doneJobs.length > 0) {
      await dbBulkPut(STORE.deleteJobs, doneJobs);
      const doneFiles = await fileRepository.getMany(doneJobs.map((job) => job.fileId));
      await dbBulkPut(
        STORE.files,
        doneFiles.map((file) => ({ ...file, status: 'deleted' as const })),
      );
    }
    if (failedJobs.length > 0) await dbBulkPut(STORE.deleteJobs, failedJobs);

    for (const job of doneJobs) callbacks.onJobUpdate(job);
    for (const job of failedJobs) callbacks.onJobUpdate(job);
    for (const job of retryJobs) callbacks.onJobUpdate(job);

    if (retryJobs.length > 0) {
      queue = queue.concat(retryJobs);
      if (waitSeconds > 0 && !signal.aborted) await sleep(waitSeconds * 1000, signal);
    }
  }

  // One bulk pass to drop deleted files from their groups and resolve emptied groups.
  if (deletedFileIds.length > 0) await duplicateRepository.removeFilesFromGroups(deletedFileIds);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });
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
