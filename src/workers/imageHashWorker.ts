// Phase 2 placeholder — computes perceptual hashes off the main thread.
// Not wired into the app yet; kept so the future thumbnail → hash → compare
// pipeline has a home. See perceptualHash.ts and similarityScore.ts.

import { dHashFromBlob } from '../features/duplicates/perceptualHash';
import { messageOf } from '../utils/errorMessage';

export interface ImageHashRequest {
  fileId: string;
  thumbnailUrl: string;
}

export interface ImageHashResponse {
  fileId: string;
  /** dHash as a hex string, or null when hashing failed. */
  hash: string | null;
  error?: string;
}

self.onmessage = async (event: MessageEvent<ImageHashRequest>) => {
  const { fileId, thumbnailUrl } = event.data;
  try {
    const response = await fetch(thumbnailUrl);
    if (!response.ok) throw new Error(`Thumbnail fetch failed (HTTP ${response.status})`);
    const hash = await dHashFromBlob(await response.blob());
    self.postMessage({ fileId, hash: hash.toString(16) } satisfies ImageHashResponse);
  } catch (e) {
    self.postMessage({ fileId, hash: null, error: messageOf(e) } satisfies ImageHashResponse);
  }
};
