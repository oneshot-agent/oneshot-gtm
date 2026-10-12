import { describe, expect, it } from "vitest";
import {
  linkedInTouchedCountRoute,
  linkedInTouchedImportRoute,
} from "../src/api/linkedin-invites.ts";

function post(body: unknown): Request {
  return new Request("http://localhost/api/linkedin/touched", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = () =>
  new Request("http://localhost/api/linkedin/touched", { headers: { host: "127.0.0.1:3030" } });

describe("/api/linkedin/touched", () => {
  it("imports an uploaded CSV through the same path, then shows the count", async () => {
    const content =
      "linkedin_url,touched_at\nhttps://www.linkedin.com/in/api-one,2026-09-01T00:00:00Z\nhttps://x.com/nope,\n";
    const res = await linkedInTouchedImportRoute(post({ content }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: 1,
      present: 0,
      rejected: 1,
      rejectedSample: ["https://x.com/nope"],
      count: 1,
    });
    const again = await linkedInTouchedImportRoute(post({ content }));
    expect(await again.json()).toMatchObject({ imported: 0, present: 1, count: 1 });
    expect(await (await linkedInTouchedCountRoute(get())).json()).toEqual({ count: 1 });
  });

  it("400s on a missing body, a bad file and a non-object body", async () => {
    for (const body of [
      {},
      { content: "name\nx\n" },
      "[1]",
      "not json",
      { content: "[]", source: 3 },
    ]) {
      const res = await linkedInTouchedImportRoute(post(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  });
});
