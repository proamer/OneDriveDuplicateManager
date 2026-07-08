export type DeleteJobStatus = 'pending' | 'deleting' | 'deleted' | 'failed';

export interface DeleteJob {
  /** Same as fileId — at most one job per file. */
  id: string;
  fileId: string;
  driveId: string;
  itemId: string;
  name: string;
  path: string;
  size: number;
  groupId: string;
  status: DeleteJobStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
