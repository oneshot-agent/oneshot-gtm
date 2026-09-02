/**
 * The one function that decides where a captured API response lives on disk.
 *
 * Both halves of the demo depend on agreeing about this: `scripts/capture-fixtures.ts`
 * writes the tree with it, and `demo.ts` reads the tree with it in a browser. It
 * therefore imports nothing — no node, no vite, no DOM.
 *
 *   /home                        → home/index.json
 *   /receipts/12                 → receipts/12/index.json
 *   /receipts?sinceDays=7&play=x → receipts/q/play-x-sinceDays-7.a1b2c3d4.json
 *
 * Query keys are sorted before the slug is built, so `?a=1&b=2` and `?b=2&a=1`
 * are one file rather than two. The slug is readable for the sake of anyone
 * reading a diff; the hash on the end is what actually guarantees uniqueness,
 * because slugifying is lossy and `ids=1,2` and `ids=1-2` would otherwise
 * collide onto the same document.
 */

/** FNV-1a, 32-bit. Not a checksum — a short stable name for a string. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function slug(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Long enough to stay legible, short enough to survive a filesystem that
  // still caps a path component at 255 bytes.
  return cleaned.slice(0, 80) || "q";
}

/**
 * Map an API path — everything the client puts after `/api` — to a path
 * relative to the fixture root, with no leading slash.
 */
export function fixturePath(apiPath: string): string {
  const [rawPath = "", rawQuery = ""] = apiPath.split("?");
  const dir = rawPath.replace(/^\/+|\/+$/g, "");

  if (!rawQuery) return `${dir}/index.json`;

  const params = [...new URLSearchParams(rawQuery).entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const canonical = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `${dir}/q/${slug(canonical)}.${hash(canonical)}.json`;
}
