import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRecord } from '../../features/scanner/scanTypes';
import { useAuth } from '../../features/auth/useAuth';
import { fileRepository } from '../../services/db/fileRepository';

/**
 * The scan no longer pre-fetches thumbnails (it's too slow on large drives), so
 * the first render usually has no cached URL — we fetch one lazily here and cache
 * it back into IndexedDB. Graph thumbnail URLs are also pre-signed and expire, so
 * an <img> load error triggers the same one-shot refresh. Files with no preview
 * (most non-image types) fall back to an extension placeholder.
 */
export function FileThumb({ file, size = 56 }: { file: FileRecord; size?: number }) {
  const { graph } = useAuth();
  const [src, setSrc] = useState<string | null>(file.thumbnailUrl);
  const triedRefresh = useRef(false);

  const loadThumbnail = useCallback(async () => {
    if (triedRefresh.current) {
      setSrc(null);
      return;
    }
    triedRefresh.current = true;
    try {
      const sets = await graph.getDriveItemThumbnails(file.itemId);
      const url = sets.value[0]?.medium?.url ?? null;
      if (url) {
        setSrc(url);
        await fileRepository.setThumbnail(file.id, url);
      } else {
        setSrc(null);
      }
    } catch {
      setSrc(null);
    }
  }, [graph, file.itemId, file.id]);

  useEffect(() => {
    setSrc(file.thumbnailUrl);
    triedRefresh.current = false;
    if (!file.thumbnailUrl) void loadThumbnail();
  }, [file.id, file.thumbnailUrl, loadThumbnail]);

  if (!src) {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase().slice(0, 4) : 'IMG';
    return (
      <span className="thumb thumb-placeholder" style={{ width: size, height: size }}>
        {extension}
      </span>
    );
  }

  return (
    <img
      className="thumb"
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => void loadThumbnail()}
    />
  );
}
