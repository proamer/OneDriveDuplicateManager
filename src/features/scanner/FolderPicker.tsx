import { useEffect, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import type { ScanFrontierFolder } from './scanTypes';
import { joinPath } from '../../utils/pathUtils';
import { messageOf } from '../../utils/errorMessage';
import { Spinner } from '../../components/common/Spinner';

interface FolderNode {
  itemId: string;
  name: string;
  path: string;
  childCount: number;
  /** null = children not loaded yet. */
  children: FolderNode[] | null;
  expanded: boolean;
  loading: boolean;
}

interface FolderPickerProps {
  /** Selected folders keyed by path. */
  selected: Map<string, ScanFrontierFolder>;
  onChange(selected: Map<string, ScanFrontierFolder>): void;
}

/**
 * Lazy folder tree with multi-select checkboxes. Checking a folder means its
 * entire subtree is scanned, so descendants of a checked folder are shown as
 * implicitly included and cannot be toggled individually.
 */
export function FolderPicker({ selected, onChange }: FolderPickerProps) {
  const { graph } = useAuth();
  const [roots, setRoots] = useState<FolderNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listFolders = async (itemId: string | null, parentPath: string): Promise<FolderNode[]> => {
    const folders: FolderNode[] = [];
    let page =
      itemId === null ? await graph.listDriveRootChildren() : await graph.listDriveItemChildren(itemId);
    for (;;) {
      for (const item of page.value) {
        if (!item.folder || !item.id) continue;
        folders.push({
          itemId: item.id,
          name: item.name,
          path: joinPath(parentPath, item.name),
          childCount: item.folder.childCount ?? 0,
          children: null,
          expanded: false,
          loading: false,
        });
      }
      const nextLink = page['@odata.nextLink'];
      if (!nextLink) break;
      page = await graph.listChildrenPage(nextLink);
    }
    return folders;
  };

  useEffect(() => {
    let disposed = false;
    setError(null);
    listFolders(null, '/')
      .then((folders) => {
        if (!disposed) setRoots(folders);
      })
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      });
    return () => {
      disposed = true;
    };
    // graph is stable for the lifetime of the auth session.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNode = (path: string, patch: Partial<FolderNode>) => {
    const apply = (nodes: FolderNode[]): FolderNode[] =>
      nodes.map((node) =>
        node.path === path
          ? { ...node, ...patch }
          : node.children
            ? { ...node, children: apply(node.children) }
            : node,
      );
    setRoots((previous) => (previous ? apply(previous) : previous));
  };

  const toggleExpand = (node: FolderNode) => {
    if (node.expanded) {
      updateNode(node.path, { expanded: false });
      return;
    }
    if (node.children === null) {
      updateNode(node.path, { expanded: true, loading: true });
      listFolders(node.itemId, node.path)
        .then((children) => updateNode(node.path, { children, loading: false }))
        .catch(() => updateNode(node.path, { children: [], loading: false, expanded: false }));
    } else {
      updateNode(node.path, { expanded: true });
    }
  };

  const toggleSelect = (node: FolderNode, checked: boolean) => {
    const next = new Map(selected);
    if (checked) {
      // Selecting a parent covers its descendants — drop now-redundant entries.
      for (const [path] of next) {
        if (path === node.path || path.startsWith(`${node.path}/`)) next.delete(path);
      }
      next.set(node.path, { itemId: node.itemId, path: node.path });
    } else {
      next.delete(node.path);
    }
    onChange(next);
  };

  const isCovered = (path: string): boolean =>
    [...selected.keys()].some((scope) => path === scope || path.startsWith(`${scope}/`));

  const renderNodes = (nodes: FolderNode[], depth: number) => (
    <ul className={`folder-tree${depth === 0 ? ' folder-tree-root' : ''}`}>
      {nodes.map((node) => {
        const checked = selected.has(node.path);
        const covered = !checked && isCovered(node.path);
        return (
          <li key={node.path}>
            <div className="folder-row">
              <button
                type="button"
                className="folder-expand"
                onClick={() => toggleExpand(node)}
                disabled={node.childCount === 0}
                aria-label={node.expanded ? 'Collapse' : 'Expand'}
              >
                {node.childCount > 0 ? (
                  <span className={`chevron small${node.expanded ? ' open' : ''}`} aria-hidden="true" />
                ) : (
                  <span className="folder-expand-spacer" />
                )}
              </button>
              <label className={`folder-label${covered ? ' folder-covered' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked || covered}
                  disabled={covered}
                  onChange={(event) => toggleSelect(node, event.target.checked)}
                />
                <span className="folder-name truncate" title={node.path}>
                  {node.name}
                </span>
                {covered && <span className="folder-hint">included</span>}
              </label>
            </div>
            {node.expanded &&
              (node.loading ? (
                <div className="folder-loading">
                  <Spinner size={13} />
                </div>
              ) : node.children && node.children.length > 0 ? (
                renderNodes(node.children, depth + 1)
              ) : (
                <div className="folder-empty">No subfolders</div>
              ))}
          </li>
        );
      })}
    </ul>
  );

  if (error) return <div className="banner banner-error">{error}</div>;
  if (roots === null) {
    return (
      <div className="folder-loading">
        <Spinner size={16} /> Loading folders…
      </div>
    );
  }
  if (roots.length === 0) return <div className="folder-empty">No folders in your OneDrive root.</div>;

  return renderNodes(roots, 0);
}
