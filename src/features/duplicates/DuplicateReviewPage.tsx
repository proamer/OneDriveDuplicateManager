import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DuplicateGroup } from './duplicateTypes';
import { duplicateRepository } from '../../services/db/duplicateRepository';
import { queueMarkedFiles } from '../delete/deleteService';
import { formatBytes } from '../../utils/formatBytes';
import { GroupCard } from '../../components/duplicate/GroupCard';
import { EmptyState } from '../../components/common/EmptyState';
import { Spinner } from '../../components/common/Spinner';

const PAGE_SIZE = 50;

export function DuplicateReviewPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [marked, setMarked] = useState({ count: 0, bytes: 0 });
  const [queueing, setQueueing] = useState(false);

  const load = useCallback(async () => {
    const [pendingGroups, summary] = await Promise.all([
      duplicateRepository.getGroups('pending'),
      duplicateRepository.getMarkedSummary(),
    ]);
    setGroups(pendingGroups);
    setMarked(summary);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshMarked = useCallback(() => {
    void duplicateRepository.getMarkedSummary().then(setMarked);
  }, []);

  const addToQueue = async () => {
    setQueueing(true);
    try {
      await queueMarkedFiles();
      navigate('/queue');
    } finally {
      setQueueing(false);
    }
  };

  if (groups === null) {
    return (
      <div className="page-loading">
        <Spinner size={24} />
      </div>
    );
  }

  const totalWasted = groups.reduce((sum, group) => sum + group.wastedBytes, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Duplicate Review</h1>
          <p className="page-subtitle">
            {groups.length === 0
              ? 'Nothing waiting for review.'
              : `${groups.length.toLocaleString()} groups · ${formatBytes(totalWasted)} recoverable. ` +
                'Pick which file to keep, mark the rest for deletion.'}
          </p>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No duplicate groups to review"
            description="Run a scan to find exact duplicates, or check Settings if you previously ignored groups."
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/scan?autostart=1')}>
                Start a scan
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="group-list">
            {groups.slice(0, visibleCount).map((group) => (
              <GroupCard key={group.id} group={group} onMutate={refreshMarked} onRemoved={() => void load()} />
            ))}
          </div>
          {groups.length > visibleCount && (
            <div className="load-more">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              >
                Show more ({(groups.length - visibleCount).toLocaleString()} remaining)
              </button>
            </div>
          )}
        </>
      )}

      {marked.count > 0 && (
        <div className="footer-bar">
          <span>
            <strong>{marked.count.toLocaleString()}</strong> file{marked.count === 1 ? '' : 's'} selected ·{' '}
            {formatBytes(marked.bytes)}
          </span>
          <button type="button" className="btn btn-primary" onClick={() => void addToQueue()} disabled={queueing}>
            {queueing ? 'Adding…' : 'Add to Delete Queue'}
          </button>
        </div>
      )}
    </>
  );
}
