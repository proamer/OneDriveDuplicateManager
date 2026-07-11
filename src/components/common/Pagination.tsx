interface PaginationProps {
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
  /** Word for the item being paged, e.g. "files" (shown in the summary). */
  label?: string;
}

/** Prev/Next pager that keeps big tables from rendering thousands of rows at once. */
export function Pagination({ page, pageSize, total, onPageChange, label = 'items' }: PaginationProps) {
  if (total <= pageSize) return null;
  const pageCount = Math.ceil(total / pageSize);
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const end = Math.min(start + pageSize, total);

  return (
    <div className="pagination">
      <span className="pagination-info">
        {(start + 1).toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()} {label}
      </span>
      <div className="pagination-controls">
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => onPageChange(current - 1)}
          disabled={current === 0}
        >
          Previous
        </button>
        <span className="pagination-page">
          Page {(current + 1).toLocaleString()} / {pageCount.toLocaleString()}
        </span>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => onPageChange(current + 1)}
          disabled={current >= pageCount - 1}
        >
          Next
        </button>
      </div>
    </div>
  );
}
