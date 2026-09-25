import { beforeEach, describe, expect, it, vi } from "vitest";

const ledgerStub = {
  isQueueDuplicate: vi.fn((_playName: string, _dedupeKey: string) => false),
  findProspectByEmail: vi.fn(() => null as { id: number } | null),
  isEmailPendingInQueue: vi.fn(() => false),
};
vi.mock("@oneshot-gtm/core", () => ({ getLedger: () => ledgerStub }));

const { emailDomain, urlDomain, isDuplicate } = await import("../src/_dedupe.ts");

describe("isDuplicate (cross-play)", () => {
  beforeEach(() => {
    ledgerStub.isQueueDuplicate.mockReset().mockReturnValue(false);
    ledgerStub.findProspectByEmail.mockReset().mockReturnValue(null);
    ledgerStub.isEmailPendingInQueue.mockReset().mockReturnValue(false);
  });

  it("true when the email is pending in the queue under another play", () => {
    ledgerStub.isQueueDuplicate.mockReturnValue(false);
    ledgerStub.findProspectByEmail.mockReturnValue(null);
    ledgerStub.isEmailPendingInQueue.mockReturnValue(true);
    expect(
      isDuplicate({ playName: "repo-interest", dedupeKey: "k", prospectEmail: "a@x.com" }),
    ).toBe(true);
  });

  it("bypasses the email checks when prospectEmail is undefined (breakup-revive)", () => {
    ledgerStub.isQueueDuplicate.mockReturnValue(false);
    ledgerStub.isEmailPendingInQueue.mockReturnValue(true); // would match if consulted
    expect(isDuplicate({ playName: "breakup-revive", dedupeKey: "k" })).toBe(false);
    expect(ledgerStub.isEmailPendingInQueue).not.toHaveBeenCalled();
  });

  // F-t_1ec69ea6-2: a routed finder passes `playName` as the array from
  // `dedupePlayNames` (its own play + design-partner-loi) so dedupe survives
  // a `play` toggle. Pin the actual multi-play branch, not just the single
  // string path every other case here exercises.
  it("checks isQueueDuplicate under EVERY play in the array, true if any matches", () => {
    ledgerStub.isQueueDuplicate.mockImplementation(
      (playName: string, dedupeKey: string) =>
        playName === "design-partner-loi" && dedupeKey === "k",
    );
    expect(isDuplicate({ playName: ["job-change", "design-partner-loi"], dedupeKey: "k" })).toBe(
      true,
    );
    expect(ledgerStub.isQueueDuplicate).toHaveBeenCalledWith("job-change", "k");
    expect(ledgerStub.isQueueDuplicate).toHaveBeenCalledWith("design-partner-loi", "k");
  });

  it("false for a multi-play array when neither play has the dedupeKey queued", () => {
    ledgerStub.isQueueDuplicate.mockReturnValue(false);
    expect(isDuplicate({ playName: ["job-change", "design-partner-loi"], dedupeKey: "k" })).toBe(
      false,
    );
  });
});

describe("emailDomain", () => {
  it("extracts the domain and lowercases it", () => {
    expect(emailDomain("Sam@Acme.Dev")).toBe("acme.dev");
  });

  it("returns null for empty / null / missing @", () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain("sam-at-acme.dev")).toBeNull();
  });

  it("handles subdomains and plus-addressing", () => {
    expect(emailDomain("sam+promo@mail.acme.dev")).toBe("mail.acme.dev");
  });
});

describe("urlDomain", () => {
  it("strips www. and lowercases", () => {
    expect(urlDomain("https://WWW.Acme.dev/about")).toBe("acme.dev");
  });

  it("returns null for null / undefined / garbage", () => {
    expect(urlDomain(null)).toBeNull();
    expect(urlDomain(undefined)).toBeNull();
    expect(urlDomain("")).toBeNull();
    expect(urlDomain("not a url")).toBeNull();
  });

  it("keeps non-www subdomains", () => {
    expect(urlDomain("https://blog.acme.dev/post")).toBe("blog.acme.dev");
  });

  it("handles http/https and paths/queries/fragments", () => {
    expect(urlDomain("http://acme.dev/path?a=1#x")).toBe("acme.dev");
  });
});
