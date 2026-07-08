import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '../../features/scanner/scanTypes';
import { useAuth } from '../../features/auth/useAuth';
import { fileRepository } from '../../services/db/fileRepository';

/**
 * Graph thumbnail URLs are pre-signed and expire after a while.
 * On load error we fetch a fresh URL once and cache it back into IndexedDB.
 */
export function FileThumb({ file, size = 56 }: { file: FileRecord; size?: number }) {
  const { graph } = useAuth();
  const [src, setSrc] = useState<string | null>(file.thumbnailUrl);
  const triedRefresh = useRef(false);

  useEffect(() => {
    setSrc(file.thumbnailUrl);
    triedRefresh.current = false;
  }, [file.id, file.thumbnailUrl]);

  const handleError = async () => {
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
  };

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
      onError={() => void handleError()}
    />
  );
}
