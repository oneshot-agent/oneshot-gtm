import { describe, expect, it } from "vitest";
import { emailDomain, urlDomain } from "../src/_dedupe.ts";

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
