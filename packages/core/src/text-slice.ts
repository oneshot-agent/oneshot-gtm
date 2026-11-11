/**
 * `text.slice(0, end)` that never stops between the two halves of a surrogate
 * pair. An emoji or styled letter cut in two leaves a lone surrogate, which is
 * not valid UTF-16: strict JSON parsers reject the whole payload holding it.
 */
export function sliceText(text: string, end: number): string {
  const out = text.slice(0, end);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}
