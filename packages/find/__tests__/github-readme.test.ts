import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  extractReadmeEmail,
  fetchProfileReadmeEmail,
  _resetReadmeCache,
} from "../src/_github-readme.ts";

const fetchMock = vi.fn();
beforeEach(() => {
  _resetReadmeCache();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  "Email me at pat@acme.dev",
  "[Email me](mailto:pat@acme.dev)",
  '<a href="mailto:pat@acme.dev">Contact me</a>',
  "Email: pat@acme.dev",
])("extracts an explicit personal contact: %s", (text) => {
  expect(extractReadmeEmail(text)).toMatchObject({ status: "found", email: "pat@acme.dev" });
});
it.each([
  "Contributor: pat@acme.dev",
  "Contact me at support@acme.dev",
  "Email me: nobody@example.com",
  "Email me at 123@noreply.github.com",
  "<!-- Email me: pat@acme.dev -->",
  "```text\nEmail me: pat@acme.dev\n```",
  "<pre>Email me: pat@acme.dev</pre>",
  "# Contributors\nEmail: pat@acme.dev",
  "Contact me: ![badge](https://badges.test/pat@acme.dev)",
  "[Contact](https://somewhere.test/pat@acme.dev)",
  "A random address: pat@acme.dev",
  "```text\nEmail me: pat@acme.dev",
  "# Contributors\n## Pat\nEmail: pat@acme.dev",
  '<a href="https://site.test/pat@acme.dev">Contact me</a>',
])("ignores unrelated or example content: %s", (text) => {
  expect(extractReadmeEmail(text).status).toBe("missing");
});
it("refuses multiple distinct personal addresses", () => {
  expect(extractReadmeEmail("Email me: pat@acme.dev or pat@other.dev").status).toBe("ambiguous");
});
const identity = { login: "pat", accountType: "User" };
function ready(text = "Email me: pat@acme.dev") {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/readme") ? new Response(text) : Response.json({ private: false }),
  );
}
it("only reads the public personal repository and coalesces requests", async () => {
  ready();
  const results = await Promise.all([
    fetchProfileReadmeEmail(identity),
    fetchProfileReadmeEmail(identity),
  ]);
  expect(results[0]).toMatchObject({ status: "found", url: "https://github.com/pat/pat#readme" });
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    "https://api.github.com/repos/pat/pat",
    "https://api.github.com/repos/pat/pat/readme",
  ]);
  await fetchProfileReadmeEmail(identity);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("caches a completed miss for 24 hours", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(0);
  try {
    await fetchProfileReadmeEmail(identity);
    await fetchProfileReadmeEmail(identity);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(86_400_001);
    await fetchProfileReadmeEmail(identity);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});
it.each([403, 429, 500])("does not cache temporary HTTP %s as a miss", async (status) => {
  fetchMock.mockImplementation(async () => new Response(null, { status }));
  expect((await fetchProfileReadmeEmail(identity)).status).toBe("unavailable");
  expect((await fetchProfileReadmeEmail(identity)).status).toBe("unavailable");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("skips organization and unknown account types and private repositories", async () => {
  await fetchProfileReadmeEmail({ ...identity, accountType: "Organization" });
  await fetchProfileReadmeEmail({ login: "pat" });
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue(Response.json({ private: true }));
  expect((await fetchProfileReadmeEmail(identity)).status).toBe("missing");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("rejects oversized content even without a content-length", async () => {
  ready("x".repeat(65_537));
  expect((await fetchProfileReadmeEmail(identity)).status).toBe("unavailable");
});
it("treats request timeout as retryable", async () => {
  fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
  expect((await fetchProfileReadmeEmail(identity)).status).toBe("unavailable");
});
