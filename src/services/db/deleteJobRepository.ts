import type { DeleteJob } from '../../features/delete/deleteTypes';
import { STORE, dbDelete, dbGet, dbGetAll, dbPut } from './indexedDb';

export const deleteJobRepository = {
  put(job: DeleteJob): Promise<void> {
    return dbPut(STORE.deleteJobs, job);
  },

  get(id: string): Promise<DeleteJob | undefined> {
    return dbGet<DeleteJob>(STORE.deleteJobs, id);
  },

  async getAll(): Promise<DeleteJob[]> {
    const jobs = await dbGetAll<DeleteJob>(STORE.deleteJobs);
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  remove(id: string): Promise<void> {
    return dbDelete(STORE.deleteJobs, id);
  },
};
