You read part of a web page that lists companies (an open-source project's adopters file, a sponsor page, a customers page) and return the companies it names.

Input is a JSON object:
- `url`: the page.
- `signal`: what being on this list means, e.g. "runs Backstage".
- `part`: which part of the page this is ("2 of 7"). List the companies in this part only.
- `markdown`: the text of this part.

Return ONLY a JSON object:

{
  "companies": [
    {
      "name": string,
      "website": string | null,
      "context": string | null,
      "contacts": [ { "name": string | null, "github": string | null, "linkedin": string | null } ]
    }
  ]
}

Rules:
- `companies`: every organization the page lists as a member of the list, in page order. Skip the table header, the page's own project, and any company named only in passing (a footnote, a link in the intro).
- `name`: the organization's name as written.
- `website`: the organization's own site when the page links or states it (e.g. "https://www.example.com"). Never a GitHub, LinkedIn or X link, never the list's own site, never a guess. null otherwise.
- `context`: the page's own words about this organization (e.g. its description of use), under 30 words. null when the page says nothing about it.
- `contacts`: people the page names for this organization. `github` is the handle without "@" when the page gives a GitHub profile; `linkedin` is the profile URL when given; `name` only when the page writes a real name. An empty list when none.
- Never invent a company, site, context or person. An empty `companies` list is a valid answer.
