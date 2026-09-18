import { beforeEach, expect, it, vi } from "vitest";
const { profile, contact } = vi.hoisted(() => ({ profile: vi.fn(), contact: vi.fn() }));
vi.mock("../src/_github-user.ts", () => ({ fetchGitHubUser: profile }));
vi.mock("../src/_contact.ts", () => ({ resolveAndVerifyContact: contact }));
const { resolveQueueContact } = await import("../src/queue-contact.ts");
const row = {
  payload_json: JSON.stringify({ name: "A Founder", repo: "org/repo" }),
  source: "find:github-stars:org/repo",
  dedupe_key: "github-stars:org/repo:founder",
  play_name: "repo-interest",
};
beforeEach(() => {
  vi.resetAllMocks();
  profile.mockResolvedValue({ name: "A Founder", email: null, blogDomain: "business.example" });
  contact.mockResolvedValue({ ok: true, email: "person@business.example" });
});
it("recovers a historical rejection from its exact GitHub dedupe identity", async () => {
  expect(await resolveQueueContact(row)).toEqual({
    email: "person@business.example",
    sourceProfileUrl: "https://github.com/founder",
    candidateLogin: "founder",
  });
  expect(profile).toHaveBeenCalledWith("founder");
  expect(contact).toHaveBeenCalledWith({
    playName: "repo-interest",
    fullName: "A Founder",
    knownEmail: null,
    companyDomain: "business.example",
  });
  expect(JSON.parse(row.payload_json)).not.toHaveProperty("email");
});
it("does not spend on a row that already has an email", async () => {
  expect(
    await resolveQueueContact({
      ...row,
      payload_json: JSON.stringify({ email: "saved@example.com" }),
    }),
  ).toEqual({});
  expect(profile).not.toHaveBeenCalled();
  expect(contact).not.toHaveBeenCalled();
});
it("refuses a mismatched dedupe key rather than looking up the wrong person", async () => {
  await expect(
    resolveQueueContact({ ...row, dedupe_key: "github-stars:other/repo:founder" }),
  ).rejects.toThrow(/No recoverable/);
  expect(profile).not.toHaveBeenCalled();
});
it("does not invent an email when resolution fails", async () => {
  contact.mockResolvedValue({ ok: false, reason: "not-found" });
  await expect(resolveQueueContact(row)).rejects.toThrow(/No verified email/);
});
it("reports an unavailable profile without starting paid contact lookup", async () => {
  profile.mockResolvedValue(null);
  await expect(resolveQueueContact(row)).rejects.toThrow(/GitHub profile lookup failed/);
  expect(contact).not.toHaveBeenCalled();
});
