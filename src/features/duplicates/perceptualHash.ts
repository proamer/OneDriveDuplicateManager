// Phase 2 placeholder — perceptual hashing for "similar image" detection.
// Works today (dHash over a thumbnail blob) but is not wired into the scan
// pipeline yet. Planned flow: thumbnail → dHash in imageHashWorker → compare
// hamming distance (similarityScore.ts) → flag as "suspicious", never as
// duplicate, and always require manual review.

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/** 64-bit difference hash of an image blob. Runs on the main thread or in a worker. */
export async function dHashFromBlob(blob: Blob): Promise<bigint> {
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: HASH_WIDTH,
    resizeHeight: HASH_HEIGHT,
    resizeQuality: 'medium',
  });
  try {
    const canvas = new OffscreenCanvas(HASH_WIDTH, HASH_HEIGHT);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available');
    context.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT);
    const { data } = context.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT);

    const luminance = new Float64Array(HASH_WIDTH * HASH_HEIGHT);
    for (let i = 0; i < luminance.length; i++) {
      luminance[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    let hash = 0n;
    for (let y = 0; y < HASH_HEIGHT; y++) {
      for (let x = 0; x < HASH_WIDTH - 1; x++) {
        hash <<= 1n;
        if (luminance[y * HASH_WIDTH + x] > luminance[y * HASH_WIDTH + x + 1]) hash |= 1n;
      }
    }
    return hash;
  } finally {
    bitmap.close();
  }
}
