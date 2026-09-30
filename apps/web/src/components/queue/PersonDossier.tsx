import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { DossierPostView, QueueDossierView } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import { timeAgo } from "../../lib/cn.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { Disclosure } from "../ledger/CaseList.tsx";

/** Posts shown before the list stops; the newest carry the signal. */
const POST_CAP = 10;

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function Heading({ children }: { children: string }) {
  return (
    <h4 className="m-0 mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </h4>
  );
}

function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-ink-cream-2 underline underline-offset-2"
    >
      <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Post({ post, index }: { post: DossierPostView; index: number }) {
  const url = safeUrl(post.url);
  const stats = [
    post.likes != null ? `${post.likes} likes` : null,
    post.replies != null ? `${post.replies} replies` : null,
  ].filter(Boolean);
  return (
    <li className="mt-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-muted">
        <span>{post.postedAt ? timeAgo(post.postedAt) : "undated"}</span>
        {post.platform && <span>· {post.platform}</span>}
        {post.isRepost && (
          <span className="rounded-sm border border-ink-rule px-1 text-[10px] uppercase">
            repost
          </span>
        )}
        {stats.length > 0 && <span>· {stats.join(" · ")}</span>}
        {url && <OutLink href={url}>open</OutLink>}
      </div>
      {post.content && (
        <div
          tabIndex={0}
          role="region"
          aria-label={`Post ${index + 1}`}
          className="mt-1 max-h-48 overflow-y-auto rounded-sm border border-ink-rule p-3 text-[12px] leading-5 text-ink-cream-2 focus-visible:outline focus-visible:outline-1"
        >
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{post.content}</p>
        </div>
      )}
    </li>
  );
}

/** The dossier body; exported for tests. */
export function DossierBody({ dossier }: { dossier: QueueDossierView }) {
  const { person, experience, education, company, posts } = dossier;
  const linkedin = safeUrl(person.linkedinUrl);
  const companyLine = company
    ? [company.industry, company.size, company.location, company.fundingStage]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="text-[12px] leading-5 text-ink-cream-2">
      {dossier.status === "summary-only" && (
        <p className="mt-2 text-ink-muted">
          Only the saved summary is available; the full research is no longer cached.
        </p>
      )}
      {dossier.status === "none" && (
        <p className="mt-2 text-ink-muted">No person research is saved for this row.</p>
      )}

      {(person.summary || person.location || linkedin || person.emails.length > 0) && (
        <>
          <Heading>About</Heading>
          {(person.fullName || person.title) && (
            <p className="m-0 mt-1">
              {[person.fullName, person.title, person.company].filter(Boolean).join(" · ")}
            </p>
          )}
          {person.summary && (
            <p className="m-0 mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {person.summary}
            </p>
          )}
          {person.location && <p className="m-0 mt-1 text-ink-muted">{person.location}</p>}
          {linkedin && (
            <p className="m-0 mt-1">
              <OutLink href={linkedin}>{linkedin}</OutLink>
            </p>
          )}
          {person.emails.length > 0 && (
            <p className="m-0 mt-1 font-mono text-[11px] [overflow-wrap:anywhere]">
              {person.emails.join(" · ")}
            </p>
          )}
          {person.phones.length > 0 && (
            <p className="m-0 mt-1 font-mono text-[11px]">{person.phones.join(" · ")}</p>
          )}
        </>
      )}

      {posts.length > 0 ? (
        <>
          <Heading>{`Recent posts · ${posts.length}`}</Heading>
          <ul className="m-0 list-none p-0">
            {posts.slice(0, POST_CAP).map((post, i) => (
              <Post
                key={post.url ?? `${post.postedAt ?? ""}:${post.content?.slice(0, 80) ?? ""}`}
                post={post}
                index={i}
              />
            ))}
          </ul>
        </>
      ) : (
        dossier.status !== "none" && (
          <>
            <Heading>Recent posts</Heading>
            <p className="m-0 mt-1 text-ink-muted">
              No posts found.
              {!dossier.newsfeedFetchedAt && " Recent posts are captured when the row is approved."}
            </p>
          </>
        )
      )}

      {experience.length > 0 && (
        <>
          <Heading>Career</Heading>
          <ul className="m-0 list-none p-0">
            {experience.map((role) => (
              <li
                key={`${role.company}|${role.title ?? ""}|${role.startDate ?? ""}|${role.endDate ?? ""}`}
                className="mt-1"
              >
                <span className="text-ink-cream">{role.title ?? "Role"}</span>
                <span className="text-ink-muted"> at </span>
                {role.company}
                <span className="font-mono text-[11px] text-ink-muted">
                  {" "}
                  {[role.startDate, role.current ? "present" : role.endDate]
                    .filter(Boolean)
                    .join(" – ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {education.length > 0 && (
        <>
          <Heading>Education</Heading>
          <ul className="m-0 list-none p-0">
            {education.map((e) => (
              <li key={`${e.school}|${e.degree ?? ""}`} className="mt-1">
                {e.school}
                {e.degree && <span className="text-ink-muted"> · {e.degree}</span>}
                {e.period && (
                  <span className="font-mono text-[11px] text-ink-muted"> {e.period}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {person.skills.length > 0 && (
        <>
          <Heading>Skills</Heading>
          <p className="m-0 mt-1 text-ink-muted">{person.skills.join(" · ")}</p>
        </>
      )}

      {company && (company.name || companyLine || company.description) && (
        <>
          <Heading>Company</Heading>
          <p className="m-0 mt-1">{[company.name, company.domain].filter(Boolean).join(" · ")}</p>
          {companyLine && <p className="m-0 mt-1 text-ink-muted">{companyLine}</p>}
          {company.description && <p className="m-0 mt-1">{company.description}</p>}
        </>
      )}

      {dossier.researchedAt && (
        <p className="m-0 mt-4 font-mono text-[11px] text-ink-faint">
          researched {timeAgo(dossier.researchedAt)}
          {dossier.newsfeedFetchedAt && ` · posts captured ${timeAgo(dossier.newsfeedFetchedAt)}`}
        </p>
      )}
    </div>
  );
}

/**
 * The full person research behind a row and their recent posts. Loaded only
 * once opened, so a page of collapsed rows costs nothing; never buys anything.
 */
export function PersonDossier({ rowId }: { rowId: number }) {
  const { masked } = usePrivacy();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["queue-dossier", rowId],
    queryFn: () => api.queueDossier(rowId),
    enabled: open && !masked && !IS_DEMO,
    staleTime: 60_000,
  });
  return (
    <section aria-label="Dossier" className="min-w-0 border-t border-ink-rule pt-4">
      <Disclosure label="Dossier" onToggle={setOpen}>
        {masked ? (
          <p className="mt-2 text-[12px] text-ink-muted">Dossier hidden in privacy mode.</p>
        ) : IS_DEMO ? (
          <p className="mt-2 text-[12px] text-ink-muted">
            The full dossier is not part of the demo.
          </p>
        ) : query.isPending ? (
          <p className="mt-2 text-[12px] text-ink-muted">Loading dossier…</p>
        ) : query.isError ? (
          <p className="mt-2 text-[12px] text-ink-muted">
            Couldn&apos;t load the dossier: {(query.error as Error).message}
          </p>
        ) : (
          <DossierBody dossier={query.data} />
        )}
      </Disclosure>
    </section>
  );
}
