/** Treat imported placeholders as missing data, without changing stored contact details. */
export function replyCompany(value: string | null): string | null {
  const company = value?.trim();
  return !company || /^(?:\(?unknown\)?|n\/a|not available|none|null|-)$/i.test(company)
    ? null
    : company;
}

/** A list preview only; the full original message remains in the conversation. */
export function replyPreview(body: string, channel: "email" | "linkedin"): string {
  let text = body.trim();
  if (channel === "email") {
    // Require a recognizable email attribution, rather than stripping ordinary “On…” prose.
    text =
      text.split(
        /(?:^|\n)\s*>|(?:^|\n)\s*-{2,}\s*Original Message\s*-{2,}|\bOn\s+(?=[^\n]{0,180}\d)[^\n]{0,240}?\bwrote\s*:/i,
      )[0] ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
}
