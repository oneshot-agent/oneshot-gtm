/**
 * Profile hosts `deepResearchPerson` / `webRead` can actually build a person
 * from. Chases a social profile; anything else is a page that happens to have
 * a person's name on it.
 *
 * Shared by `research-prospects` (apps/cli) and the angle evidence gather
 * (issue #355) so both paths agree on which stored URL is worth paying for.
 */
const RESEARCHABLE_HOST =
  /^https?:\/\/([a-z0-9-]+\.)*(linkedin\.com|x\.com|twitter\.com|github\.com)\//i;

/** True when a URL is a profile worth handing to deepResearchPerson / webRead. */
export function isResearchableUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  return trimmed ? RESEARCHABLE_HOST.test(trimmed) : false;
}

/**
 * The social URL to chase for live evidence, if any.
 *
 * `source_profile_url` used to win unconditionally, which sent research at
 * whatever page the finder happened to surface. For a luma-event that is a
 * `luma.com/user/<handle>` page — for someone who hosts no events its entire
 * content is "Nothing Here, Yet", so the call burned a slot and returned
 * nothing while a perfectly good `linkedin_url` sat unused in the next column.
 * 68 prospects were in exactly that state.
 *
 * So: prefer whichever column holds a researchable profile, `source_profile_url`
 * first when both qualify. Fall back to a non-researchable `source_profile_url`
 * only when there is nothing better — it is still more than an email alone.
 */
export function researchUrl(row: {
  source_profile_url: string | null;
  linkedin_url: string | null;
}): string | null {
  const source = row.source_profile_url?.trim() || null;
  const linkedin = row.linkedin_url?.trim() || null;
  if (isResearchableUrl(source)) return source;
  if (isResearchableUrl(linkedin)) return linkedin;
  return source ?? linkedin;
}
