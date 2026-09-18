import { beforeEach, expect, it, vi } from "vitest";
const { find, verify, readme, gate } = vi.hoisted(() => ({
  find: vi.fn(),
  verify: vi.fn(),
  readme: vi.fn(),
  gate: vi.fn(),
}));
vi.mock("../src/_sdk-safe.ts", () => ({
  safeFindEmail: find,
  safeVerifyEmail: verify,
  safePeopleSearch: vi.fn(),
}));
vi.mock("../src/_github-readme.ts", () => ({ fetchProfileReadmeEmail: readme }));
vi.mock("../src/_breaker.ts", () => ({
  isCircuitOpen: () => false,
  recordResolutionOutcome: () => {},
}));
vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0,
  }),
}));
vi.mock("../src/_qualify.ts", () => ({ qualifyPostEnrich: gate }));
const { resolveAndVerifyContact, resolveVerifyEnrichQualify } = await import("../src/_contact.ts");
const args = {
  playName: "repo-interest",
  fullName: "Pat Lee",
  companyDomain: "acme.dev",
  githubIdentity: { login: "pat", accountType: "User" },
};
beforeEach(() => {
  vi.resetAllMocks();
  gate.mockResolvedValue({ action: "reject", reason: "off ICP", costUsd: 0 });
  find.mockResolvedValue({ result: { status: "completed", found: false, cost: 0 }, receiptId: 1 });
  verify.mockResolvedValue({
    result: { status: "completed", deliverable: true, cost: 0.01 },
    receiptId: 2,
  });
  readme.mockResolvedValue({
    status: "found",
    email: "pat@personal.dev",
    url: "https://github.com/pat/pat#readme",
  });
});
it("uses README only after lookup miss and retains provenance and spend", async () => {
  const result = await resolveAndVerifyContact(args);
  expect(result).toMatchObject({
    ok: true,
    email: "pat@personal.dev",
    costUsd: 0.01,
    emailSource: { kind: "github-profile-readme", url: "https://github.com/pat/pat#readme" },
  });
  expect(find.mock.invocationCallOrder[0]).toBeLessThan(readme.mock.invocationCallOrder[0]!);
  expect(readme.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]!);
});
it("does not fetch README or buy discovery after a verified public email", async () => {
  expect(await resolveAndVerifyContact({ ...args, knownEmail: "pat@acme.dev" })).toMatchObject({
    ok: true,
  });
  expect(find).not.toHaveBeenCalled();
  expect(readme).not.toHaveBeenCalled();
});
it("tries domain discovery after unusable public email, then README", async () => {
  verify.mockResolvedValueOnce({ result: { deliverable: false, cost: 0.01 } });
  expect(await resolveAndVerifyContact({ ...args, knownEmail: "pat@acme.dev" })).toMatchObject({
    ok: true,
    costUsd: 0.02,
  });
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]!);
});
it("skips unavailable discovery inputs and tries the final fallback", async () => {
  expect(
    await resolveAndVerifyContact({ ...args, fullName: null, companyDomain: null }),
  ).toMatchObject({ ok: true });
  expect(find).not.toHaveBeenCalled();
});
it("never re-verifies the same undeliverable address from the README", async () => {
  find.mockResolvedValue({ result: { found: true, email: "pat@personal.dev", cost: 0 } });
  verify.mockResolvedValue({ result: { deliverable: false, cost: 0.01 } });
  expect(await resolveAndVerifyContact(args)).toMatchObject({ ok: false, reason: "undeliverable" });
  expect(verify).toHaveBeenCalledTimes(1);
});
it.each(["find", "verify"])("does not fall through after temporary %s failure", async (stage) => {
  if (stage === "find") find.mockResolvedValue({ result: { status: "error", cost: 0 } });
  else {
    find.mockResolvedValue({ result: { found: true, email: "pat@acme.dev", cost: 0 } });
    verify.mockResolvedValue({ result: { status: "error", cost: 0 } });
  }
  expect(await resolveAndVerifyContact(args)).toMatchObject({
    ok: false,
    reason: "platform-error",
  });
  expect(readme).not.toHaveBeenCalled();
});
it("stops duplicates before verification and does not search for another address", async () => {
  const result = await resolveAndVerifyContact({
    ...args,
    knownEmail: "pat@acme.dev",
    isDuplicate: () => true,
  });
  expect(result).toMatchObject({ ok: false, reason: "duplicate" });
  expect(readme).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
});
it("leaves other finders unchanged", async () => {
  const { githubIdentity: _, ...other } = args;
  expect(await resolveAndVerifyContact(other)).toMatchObject({ ok: false, reason: "not-found" });
  expect(readme).not.toHaveBeenCalled();
});

it("retains README provenance when a later role check rejects", async () => {
  expect(
    await resolveVerifyEnrichQualify({ ...args, icp: "founders", person: { name: "Pat Lee" } }),
  ).toMatchObject({
    ok: false,
    reason: "role",
    email: "pat@personal.dev",
    emailSource: { kind: "github-profile-readme" },
  });
  expect(readme).toHaveBeenCalledTimes(1);
});
it("does not search README to bypass a role rejection", async () => {
  expect(
    await resolveVerifyEnrichQualify({
      ...args,
      knownEmail: "pat@acme.dev",
      icp: "founders",
      person: { name: "Pat Lee" },
    }),
  ).toMatchObject({ ok: false, reason: "role" });
  expect(readme).not.toHaveBeenCalled();
});
