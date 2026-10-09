export const COPY_CHUNK_BYTES = 8 * 1024 * 1024;
export function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
// Consume the response under the same deadline. Metadata responses are small.
export async function timedFetch(url: string, init: RequestInit, timeout = 180000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeout);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { ...init, signal });
  return new Response(await response.text(), { status: response.status, statusText: response.statusText, headers: response.headers });
}
export async function downloadChunk(url: string, start: number, end: number, size: number, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
  if (response.status !== 206 && !(response.status === 200 && start === 0 && end === size)) {
    await response.body?.cancel();
    throw new Error(`OneDrive ไม่ส่งข้อมูลตามช่วงที่ขอ (HTTP ${response.status})`);
  }
  const range = response.headers.get('Content-Range');
  if (range && range !== `bytes ${start}-${end - 1}/${size}`) {
    await response.body?.cancel(); throw new Error('OneDrive ส่งข้อมูลคนละช่วงกับที่ขอ');
  }
  // Never buffer an ignored range/full 119GB file, even if a server misreports status.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OneDrive ไม่มีข้อมูลไฟล์');
  const parts: ArrayBuffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > end - start || received > COPY_CHUNK_BYTES) throw new Error('ข้อมูลเกินขนาด chunk ที่ขอ');
      parts.push(value.slice().buffer);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (received !== end - start) throw new Error('ข้อมูลดาวน์โหลดมีขนาดไม่ตรง');
  return new Blob(parts);
}
