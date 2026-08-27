import { describe, expect, test } from "vitest";
import { loadXCreds, oauth1Header, queryString, rfc3986 } from "../src/_x-oauth1.ts";

describe("rfc3986", () => {
  test("encodes the five characters encodeURIComponent leaves literal", () => {
    // A signer that skips these signs one string and sends another — a 401
    // that looks like bad creds.
    expect(rfc3986("!*'()")).toBe("%21%2A%27%28%29");
  });

  test("matches encodeURIComponent everywhere else", () => {
    expect(rfc3986("a b+c,d/e")).toBe("a%20b%2Bc%2Cd%2Fe");
    expect(rfc3986("plain-safe_chars.~")).toBe("plain-safe_chars.~");
  });
});

describe("queryString", () => {
  test("encodes both sides and drops empty params", () => {
    expect(queryString({ a: "x y", b: undefined, c: "", d: 5 })).toBe("a=x%20y&d=5");
  });
});

describe("loadXCreds", () => {
  test("names exactly the missing vars", () => {
    expect(() => loadXCreds({ X_API_KEY: "k", X_API_SECRET: "s" })).toThrow(
      /X_ACCESS_TOKEN, X_ACCESS_SECRET/,
    );
  });

  test("returns the four values when all are set", () => {
    const c = loadXCreds({
      X_API_KEY: "k",
      X_API_SECRET: "s",
      X_ACCESS_TOKEN: "t",
      X_ACCESS_SECRET: "ts",
    });
    expect(c).toEqual({ apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "ts" });
  });
});

describe("oauth1Header", () => {
  test("reproduces the worked example from the X developer docs", () => {
    // docs.x.com "Creating a signature" — the canonical known-answer vector.
    // The example signs body params; sent as query params they normalize into
    // the identical signature base string.
    const creds = {
      apiKey: "xvz1evFS4wEEPTGEFPHBog",
      apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    };
    const url =
      "https://api.twitter.com/1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21";
    const header = oauth1Header(creds, "POST", url, {
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    });
    expect(header).toContain('oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D"');
    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_version="1.0"');
  });

  test("two calls differ only by nonce/timestamp when not pinned", () => {
    const creds = { apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d" };
    const h1 = oauth1Header(creds, "GET", "https://api.twitter.com/2/users/by/username/x");
    const h2 = oauth1Header(creds, "GET", "https://api.twitter.com/2/users/by/username/x");
    expect(h1).not.toBe(h2); // fresh nonce each call
    expect(h1).toContain('oauth_consumer_key="a"');
  });
});
