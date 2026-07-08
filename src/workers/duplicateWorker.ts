import { buildDuplicateGroups } from '../features/duplicates/duplicateEngine';
import type {
  DuplicateWorkerRequest,
  DuplicateWorkerResponse,
} from '../features/duplicates/duplicateTypes';
import { duplicateRepository } from '../services/db/duplicateRepository';
import { fileRepository } from '../services/db/fileRepository';
import { messageOf } from '../utils/errorMessage';

const post = (message: DuplicateWorkerResponse) => self.postMessage(message);

self.onmessage = (event: MessageEvent<DuplicateWorkerRequest>) => {
  if (event.data.type === 'group') void run(event.data.scanSessionId);
};

async function run(scanSessionId: string): Promise<void> {
  try {
    post({ type: 'progress', processed: 0, total: 0, groupsFound: 0, message: 'Loading scanned files…' });
    const files = await fileRepository.getBySession(scanSessionId);
    const previousGroups = new Map((await duplicateRepository.getAllGroups()).map((g) => [g.id, g]));
    const previousItems = new Map((await duplicateRepository.getAllItems()).map((i) => [i.id, i]));
    const ignoredKeys = new Set((await duplicateRepository.getIgnoreEntries()).map((e) => e.groupKey));

    post({
      type: 'progress',
      processed: 0,
      total: files.length,
      groupsFound: 0,
      message: `Comparing hashes of ${files.length.toLocaleString()} images…`,
    });
    const result = buildDuplicateGroups({ files, scanSessionId, previousGroups, previousItems, ignoredKeys });

    post({
      type: 'progress',
      processed: files.length,
      total: files.length,
      groupsFound: result.groups.length,
      message: 'Saving duplicate groups…',
    });
    await duplicateRepository.replaceAll(result.groups, result.items);

    post({
      type: 'done',
      groupsFound: result.groups.filter((g) => g.status === 'pending').length,
      duplicateFiles: result.duplicateFiles,
      wastedBytes: result.wastedBytes,
    });
  } catch (e) {
    post({ type: 'error', error: messageOf(e) });
  }
}
