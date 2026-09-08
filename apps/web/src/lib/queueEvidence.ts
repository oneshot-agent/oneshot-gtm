/**
 * The one line of evidence that says why a candidate is in the queue.
 *
 * A queued row is pre-enrichment: there is no role or dossier yet, only
 * whatever the finder saw. That evidence is the most useful thing about the
 * row and it was reachable only by expanding it, which left five rows looking
 * interchangeable when each had been found for a completely different reason.
 *
 * Keyed off the play rather than sniffed from the payload keys, because the
 * same key does not mean the same thing twice: `role` on luma-events is the
 * attendee's, `newRole` on job-change is the person's new one, and labelling
 * either with the other's word would put a false sentence on the page.
 *
 * The per-play field names come from `packages/find/src/_priority-adapters.ts`,
 * which already reads every queued payload to score it. Keep the two in step:
 * that file is the one that knows what a finder actually enqueues, and the
 * first draft of this one guessed from the seeded ledger instead and got
 * hiring-signal wrong (`role`, where the finder writes `jobTitle`) while
 * missing stack-consolidation, breakup-revive and the three x-* plays.
 *
 * Pure and total: an unrecognised play, a missing field or a payload of the
 * wrong shape all return null and the row simply renders without a line.
 */

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** `amount` arrives pre-formatted ("$4.2M"); `amountUsd` arrives as a number. */
function amount(payload: Record<string, unknown>): string | null {
  const pretty = str(payload, "amount");
  if (pretty) return pretty;
  const n = payload["amountUsd"];
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;
}

function join(parts: Array<string | null>, sep = " · "): string | null {
  const kept = parts.filter((p): p is string => p != null && p.length > 0);
  return kept.length > 0 ? kept.join(sep) : null;
}

export function queueEvidence(playName: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;

  switch (playName) {
    case "show-hn":
      return str(p, "postTitle");

    case "post-funding": {
      const round = str(p, "round");
      if (!round) return null;
      const lead = str(p, "leadInvestor");
      return join([`raised ${round}`, amount(p), lead ? `led by ${lead}` : null]);
    }

    case "hiring-signal": {
      // `jobTitle` from the finder, `role` in the seeded ledger.
      const opening = str(p, "jobTitle") ?? str(p, "role");
      return opening ? `hiring: ${opening}` : null;
    }

    case "job-change": {
      const to = join([str(p, "newRole"), str(p, "newCompany")], " at ");
      const from = str(p, "previousCompany");
      if (!to) return from ? `left ${from}` : null;
      return from ? `${from} → ${to}` : to;
    }

    case "podcast-guest": {
      // `podcast` in the seeded ledger, `podcastName` from the live finder.
      const show = str(p, "podcast") ?? str(p, "podcastName");
      const episode = str(p, "episodeTitle");
      if (!show) return episode;
      return episode ? `${show}: ${episode}` : `guest on ${show}`;
    }

    case "competitor-switch": {
      const competitor = str(p, "competitor");
      return competitor ? `on ${competitor}` : null;
    }

    case "luma-events":
      return str(p, "eventTitle");

    case "github-stars":
    case "github-topics":
    case "repo-interest": {
      const repo = str(p, "repoLabel") ?? str(p, "repo");
      return repo ? `starred ${repo}` : null;
    }

    case "stack-consolidation": {
      const stack = str(p, "vendorStack");
      return stack ? `runs ${stack}` : null;
    }

    case "breakup-revive": {
      const n = p["daysCold"];
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? `${n}d cold` : null;
    }

    case "x-repost-intro":
    case "x-amplify":
    case "x-amplify-dm": {
      const seed = str(p, "seedHandle");
      const followers = p["followers"];
      const reach =
        typeof followers === "number" && followers > 0
          ? followers >= 1000
            ? `${(followers / 1000).toFixed(1)}k followers`
            : `${followers} followers`
          : null;
      if (!seed) return reach;
      return join([p["mode"] === "quote" ? `quoted ${seed}` : `reposted ${seed}`, reach]);
    }

    case "accelerator-batch": {
      const cohort = str(p, "cohort");
      return cohort ? `cohort ${cohort}` : null;
    }

    case "new-business":
    case "free-pilot": {
      // local-business (#457) enqueues `businessType`; local-registry (#459)
      // enqueues `sourceLabel`/`matchedDateIso`/`subjectType` — both route
      // through this same play, so branch on whichever shape is present.
      const businessType = str(p, "businessType");
      if (businessType) return `matched ${businessType}`;
      const label = str(p, "sourceLabel");
      const matched = str(p, "matchedDateIso");
      const subjectType = str(p, "subjectType");
      // nppes-only: NPI-1 (individual) vs NPI-2 (organization) — tells a
      // reviewer why a "company" row shows a person's name instead of
      // leaving them to assume a mapping bug (see RegistryRecord's doc).
      const subject = subjectType ? `${subjectType} record` : null;
      if (!label) return subject;
      const labelled = matched ? `${label} — matched ${matched.slice(0, 10)}` : label;
      return subject ? `${labelled} (${subject})` : labelled;
    }

    // gov-solicitation's two routes share the same evidence shape: the
    // notice title, plus the agency when known.
    case "sources-sought":
    case "design-partner-loi": {
      const title = str(p, "title");
      if (!title) return null;
      const agency = str(p, "agency");
      return agency ? `${title} — ${agency}` : title;
    }

    case "civic-pilot": {
      const title = str(p, "agendaItemTitle");
      if (!title) return null;
      const city = str(p, "city");
      return city ? `${title} — ${city}` : title;
    }

    // gov-solicitation's two routes share the same evidence shape: the
    // notice title, plus the agency when known.
    case "sources-sought":
    case "design-partner-loi": {
      const title = str(p, "title");
      if (!title) return null;
      const agency = str(p, "agency");
      return agency ? `${title} — ${agency}` : title;
    }

    case "civic-pilot": {
      const title = str(p, "agendaItemTitle");
      if (!title) return null;
      const city = str(p, "city");
      return city ? `${title} — ${city}` : title;
    }

    default:
      return null;
  }
}
