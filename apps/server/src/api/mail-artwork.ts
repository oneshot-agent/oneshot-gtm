const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;

/** Bound streamed bodies as well as declared lengths before buffering artwork. */
export async function readMailArtwork(req: Request): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_ARTWORK_BYTES) {
    await req.body?.cancel();
    throw new Error("Artwork exceeds 20 MB");
  }
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARTWORK_BYTES) {
        await reader.cancel();
        throw new Error("Artwork exceeds 20 MB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
