// Phase 2 placeholder — comparison rules for perceptual hashes.
// Similar images are only ever "suspicious" and always require manual review;
// they must never be auto-classified as exact duplicates.

export const HASH_BITS = 64;

/** Hamming distance ≤ this → suspiciously similar. */
export const SUSPICIOUS_MAX_DISTANCE = 10;

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let bits = 0;
  while (diff > 0n) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits;
}

/** 0..1 — 1 means identical perceptual hashes. */
export function similarityScore(a: bigint, b: bigint): number {
  return 1 - hammingDistance(a, b) / HASH_BITS;
}

export function isSuspiciouslySimilar(a: bigint, b: bigint): boolean {
  return hammingDistance(a, b) <= SUSPICIOUS_MAX_DISTANCE;
}
