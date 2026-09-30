import type { QueueDossierView } from "@oneshot-gtm/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DossierBody } from "../PersonDossier.tsx";

const base: QueueDossierView = {
  status: "complete",
  researchedAt: "2026-09-01T00:00:00Z",
  person: {
    fullName: "Ada Lovelace",
    title: "Head of AI Platform",
    company: "Analytical Engines",
    location: "London",
    summary: "Builds the agent platform.",
    linkedinUrl: "https://www.linkedin.com/in/ada-l",
    emails: ["ada@engines.example"],
    phones: [],
    skills: ["Governance"],
  },
  experience: [
    {
      company: "Analytical Engines",
      title: "Head",
      startDate: "Jan 2023",
      endDate: null,
      current: true,
    },
  ],
  education: [{ school: "University of London", degree: "BSc", period: null }],
  company: null,
  posts: [
    {
      platform: "linkedin",
      content: "RT @someone: their words",
      url: "javascript:alert(1)",
      postedAt: "2026-09-20T00:00:00Z",
      likes: 4,
      replies: null,
      shares: null,
      isRepost: true,
      source: "newsfeed",
    },
  ],
  newsfeedFetchedAt: "2026-09-21T00:00:00Z",
};

describe("DossierBody", () => {
  it("renders every section it has data for", () => {
    const html = renderToStaticMarkup(<DossierBody dossier={base} />);
    for (const text of ["About", "Recent posts · 1", "Career", "Education", "Skills"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Builds the agent platform.");
    expect(html).toContain("repost");
    expect(html).toContain("4 likes");
    expect(html).not.toContain("javascript:");
  });

  it("says when posts are not captured yet", () => {
    const html = renderToStaticMarkup(
      <DossierBody dossier={{ ...base, posts: [], newsfeedFetchedAt: null }} />,
    );
    expect(html).toContain("No posts found.");
    expect(html).toContain("captured when the row is approved");
  });

  it("explains a summary-only or missing dossier", () => {
    expect(
      renderToStaticMarkup(<DossierBody dossier={{ ...base, status: "summary-only" }} />),
    ).toContain("no longer cached");
    const none = renderToStaticMarkup(
      <DossierBody
        dossier={{
          ...base,
          status: "none",
          person: { ...base.person, summary: null, location: null, linkedinUrl: null, emails: [] },
          posts: [],
        }}
      />,
    );
    expect(none).toContain("No person research is saved");
    expect(none).not.toContain("Recent posts");
  });
});
