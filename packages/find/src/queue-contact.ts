import type { QueueRow } from "@oneshot-gtm/core";
import { fetchGitHubUser } from "./_github-user.ts";
import { resolveAndVerifyContact } from "./_contact.ts";

/** Finish contact lookup after a human overrides an early GitHub rejection. */
export async function resolveQueueContact(
  row: Pick<QueueRow, "payload_json" | "source" | "dedupe_key" | "play_name">,
): Promise<Record<string, unknown>> {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Queue target is not an object");
  }
  if (typeof payload.email === "string" && payload.email.trim()) return {};
  const repo = /^find:github-stars:([^:]+)$/.exec(row.source)?.[1];
  const prefix = repo ? `github-stars:${repo}:` : null;
  const login =
    prefix && row.dedupe_key.startsWith(prefix) ? row.dedupe_key.slice(prefix.length) : "";
  if (!login || !/^[a-zA-Z0-9-]{1,39}$/.test(login)) {
    throw new Error(
      "No recoverable GitHub profile on this row; enter a verified prospect email manually",
    );
  }
  const user = await fetchGitHubUser(login);
  if (!user) throw new Error("GitHub profile lookup failed; retry later");
  // A human has already approved the fit. Resolve the contact without re-running
  // the ICP gate that originally rejected it. Never guess or construct an email.
  const contact = await resolveAndVerifyContact({
    playName: row.play_name,
    fullName: user.name ?? (typeof payload.name === "string" ? payload.name : null),
    knownEmail: user.email,
    companyDomain: user.blogDomain,
  });
  if (!contact.ok)
    throw new Error(
      `No verified email resolved (${contact.reason}); enter one manually or retry later`,
    );
  return {
    email: contact.email,
    sourceProfileUrl: `https://github.com/${login}`,
    candidateLogin: login,
  };
}
