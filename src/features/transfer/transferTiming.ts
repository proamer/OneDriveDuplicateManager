export interface TransferTiming {
  jobId: string;
  trackedFrom: number;
  activeMs: number;
  transferredBytes: number;
  completedFiles: number;
  updatedAt: number;
  finishedAt?: number;
}
export function transferMetrics(timing: TransferTiming, createdAt: string, now: number, running: boolean, remainingBytes: number, remainingFiles: number) {
  const end = timing.finishedAt ?? now;
  const activeMs = timing.activeMs + (running ? Math.max(0, end - timing.updatedAt) : 0);
  const downtimeMs = Math.max(0, end - timing.trackedFrom - activeMs);
  const bytesPerSecond = activeMs > 0 ? timing.transferredBytes / (activeMs / 1000) : 0;
  const filesPerSecond = activeMs > 0 ? timing.completedFiles / (activeMs / 1000) : 0;
  // Many tiny files spend most time in API calls: bytes alone can understate ETA.
  const seconds = Math.max(remainingBytes > 0 ? remainingBytes / bytesPerSecond : 0, remainingFiles > 0 ? remainingFiles / filesPerSecond : 0);
  const etaMs = activeMs >= 15000 && timing.completedFiles >= 3 && Number.isFinite(seconds) ? seconds * 1000 : undefined;
  return { elapsedMs: Math.max(0, end - Date.parse(createdAt)), activeMs, downtimeMs, bytesPerSecond, etaMs,
    unknownMs: Math.max(0, timing.trackedFrom - Date.parse(createdAt)) };
}
export function durationText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที ${seconds % 60} วินาที`;
}
