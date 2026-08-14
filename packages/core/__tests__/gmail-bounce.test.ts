import { describe, expect, it } from "vitest";
import {
  classifyBounce,
  parseBounce,
  type GmailMessageMeta,
  type GmailPayloadPart,
} from "../src/gmail.ts";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/** Wrap parts in the multipart/report envelope Gmail returns for a DSN. */
function dsn(opts: {
  from?: string;
  subject?: string;
  humanText?: string;
  report?: string;
}): GmailMessageMeta {
  const parts: GmailPayloadPart[] = [];
  if (opts.humanText) parts.push({ mimeType: "text/plain", body: { data: b64(opts.humanText) } });
  if (opts.report) {
    parts.push({ mimeType: "message/delivery-status", body: { data: b64(opts.report) } });
  }
  return {
    id: "msg-1",
    threadId: "thread-1",
    internalDate: "1755000000000",
    payload: {
      mimeType: "multipart/report",
      headers: [
        {
          name: "From",
          value: opts.from ?? "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        },
        { name: "Subject", value: opts.subject ?? "Delivery Status Notification (Failure)" },
      ],
      parts,
    },
  };
}

describe("classifyBounce", () => {
  it.each([
    ["5.1.1", "smtp; 550 user unknown", "hard"],
    ["5.0.0", null, "hard"],
    ["4.2.2", "smtp; 452 mailbox full", "soft"],
    ["4.4.1", null, "soft"],
    // 5.7.x is the policy class — a verdict on the message, not the mailbox.
    ["5.7.1", "smtp; 550 5.7.1 message rejected", "block"],
    ["5.7.26", "smtp; 550 unauthenticated", "block"],
    // Servers that reject on policy with a plain 5.x.x and say so only in prose.
    ["5.2.0", "smtp; 550 message identified as spam", "block"],
    ["5.4.1", "smtp; 550 listed on Spamhaus", "block"],
  ] as const)("%s → %s", (code, diagnostic, expected) => {
    expect(classifyBounce(code, diagnostic)).toBe(expected);
  });

  it("falls back to the bare SMTP reply class when no enhanced code exists", () => {
    expect(classifyBounce(null, "smtp; 550 No such user here")).toBe("hard");
    expect(classifyBounce(null, "smtp; 452 try again later")).toBe("soft");
    expect(classifyBounce(null, "smtp; 554 blocked by policy")).toBe("block");
  });

  it("reads an enhanced code embedded in the diagnostic when the Status field is absent", () => {
    expect(classifyBounce(null, "smtp; 550 5.1.1 user unknown")).toBe("hard");
  });

  it("treats unparseable severity as soft rather than guessing hard", () => {
    // `hard` suppresses the address permanently. Guessing it from a message we
    // couldn't actually read would silently drop a live prospect.
    expect(classifyBounce(null, null)).toBe("soft");
    expect(classifyBounce(null, "something went wrong")).toBe("soft");
  });
});

describe("parseBounce — structured delivery-status report", () => {
  it("extracts recipient, status and diagnostic from a hard bounce", () => {
    const msg = dsn({
      report: [
        "Reporting-MTA: dns; googlemail.com",
        "",
        "Final-Recipient: rfc822; jane@dead.example",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach",
        " does not exist.",
      ].join("\r\n"),
    });
    expect(parseBounce(msg)).toEqual([
      {
        recipient: "jane@dead.example",
        kind: "hard",
        statusCode: "5.1.1",
        // Folded continuation line is joined, not truncated mid-sentence.
        diagnostic: "smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
      },
    ]);
  });

  it("classifies a 5.7.1 policy rejection as a block, not a dead address", () => {
    const msg = dsn({
      report: [
        "Final-Recipient: rfc822; bob@corp.example",
        "Action: failed",
        "Status: 5.7.1",
        "Diagnostic-Code: smtp; 550 5.7.1 Message rejected as spam",
      ].join("\r\n"),
    });
    expect(parseBounce(msg)[0]).toMatchObject({ recipient: "bob@corp.example", kind: "block" });
  });

  it("classifies a 4.x.x as soft", () => {
    const msg = dsn({
      report: [
        "Final-Recipient: rfc822; full@corp.example",
        "Action: delayed",
        "Status: 4.2.2",
        "Diagnostic-Code: smtp; 452 4.2.2 Mailbox full",
      ].join("\r\n"),
    });
    expect(parseBounce(msg)[0]).toMatchObject({ kind: "soft" });
  });

  it("returns one entry per failed recipient and skips delivered ones", () => {
    const msg = dsn({
      report: [
        "Reporting-MTA: dns; mx.example",
        "",
        "Final-Recipient: rfc822; ok@corp.example",
        "Action: delivered",
        "Status: 2.0.0",
        "",
        "Final-Recipient: rfc822; gone@corp.example",
        "Action: failed",
        "Status: 5.1.1",
      ].join("\r\n"),
    });
    const out = parseBounce(msg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ recipient: "gone@corp.example", kind: "hard" });
  });

  it("lowercases the recipient and strips the address-type prefix", () => {
    const msg = dsn({
      report: ["Final-Recipient: rfc822; <Jane.Doe@Dead.Example>", "Status: 5.1.1"].join("\r\n"),
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("jane.doe@dead.example");
  });
});

describe("parseBounce — prose fallback", () => {
  it("scrapes a DSN with no conforming report part", () => {
    const msg = dsn({
      humanText: [
        "** Address not found **",
        "",
        "Your message wasn't delivered to bob@nowhere.example because the address",
        "couldn't be found, or is unable to receive mail.",
        "",
        "The response from the remote server was:",
        "550 5.1.1 <bob@nowhere.example>: Recipient address rejected: User unknown",
      ].join("\n"),
    });
    expect(parseBounce(msg)[0]).toMatchObject({
      recipient: "bob@nowhere.example",
      kind: "hard",
      statusCode: "5.1.1",
    });
  });

  it("prefers the address on the SMTP response line over the quoted original sender", () => {
    const msg = dsn({
      humanText: [
        "Delivery to the following recipient failed permanently:",
        "",
        "From: founder@ourdomain.example",
        "",
        "550 5.1.1 <target@dead.example>: User unknown",
      ].join("\n"),
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("target@dead.example");
  });

  it("never treats the daemon's own address as the failed recipient", () => {
    const msg = dsn({
      humanText: "mailer-daemon@googlemail.com reports: 550 5.1.1 delivery failed",
    });
    expect(parseBounce(msg)).toEqual([]);
  });
});

describe("parseBounce — non-bounces", () => {
  it("ignores an ordinary reply", () => {
    const msg: GmailMessageMeta = {
      id: "m",
      threadId: "t",
      internalDate: "1755000000000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Jane <jane@corp.example>" },
          { name: "Subject", value: "Re: quick question" },
        ],
        body: { data: b64("Thanks — let's talk next week.") },
      },
    };
    expect(parseBounce(msg)).toEqual([]);
  });

  it("ignores ordinary mail that merely contains a 5xx-looking number and an address", () => {
    // The Gmail query is a coarse net; without the DSN-shape gate this would
    // parse as a hard bounce and suppress a live prospect.
    const msg: GmailMessageMeta = {
      id: "m",
      threadId: "t",
      internalDate: "1755000000000",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Sam <sam@corp.example>" },
          { name: "Subject", value: "we hit 550 users" },
        ],
        body: { data: b64("We just passed 550 users — reach me at sam@corp.example.") },
      },
    };
    expect(parseBounce(msg)).toEqual([]);
  });

  it("returns nothing when a report part exists but names no recipient", () => {
    const msg = dsn({ report: "Reporting-MTA: dns; mx.example\r\nX-Postfix-Queue-ID: ABC" });
    expect(parseBounce(msg)).toEqual([]);
  });
});

describe("parseBounce — success reports", () => {
  it("ignores a 2.x.x status block with no Action field", () => {
    // Some MTAs emit a success report without an Action. Recording it would
    // inflate the failure counts doctor reports off an actual delivery.
    const msg = dsn({
      report: ["Final-Recipient: rfc822; ok@corp.example", "Status: 2.0.0"].join("\r\n"),
    });
    expect(parseBounce(msg)).toEqual([]);
  });

  it("still records a failure that carries no Action field", () => {
    const msg = dsn({
      report: ["Final-Recipient: rfc822; gone@corp.example", "Status: 5.1.1"].join("\r\n"),
    });
    expect(parseBounce(msg)[0]).toMatchObject({ kind: "hard" });
  });
});

describe("parseBounce — prose fallback, review hardening", () => {
  it("records a failed recipient at a no-reply address", () => {
    // A blanket daemon-pattern filter would discard this and the hard bounce
    // would never be recorded or suppressed.
    const msg = dsn({
      humanText: "550 5.1.1 <no-reply@customer.example>: User unknown",
    });
    expect(parseBounce(msg)[0]).toMatchObject({
      recipient: "no-reply@customer.example",
      kind: "hard",
    });
  });

  it("never returns the DSN's own sender as the failed recipient", () => {
    const msg = dsn({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      humanText: "mailer-daemon@googlemail.com: 550 5.1.1 delivery failed",
    });
    expect(parseBounce(msg)).toEqual([]);
  });

  it("excludes the actual sender address even when it isn't daemon-shaped", () => {
    const msg = dsn({
      from: "Bounce Handler <bounces@relay.example>",
      subject: "Undelivered Mail Returned to Sender",
      humanText: "bounces@relay.example reports: 550 5.1.1 failure",
    });
    expect(parseBounce(msg)).toEqual([]);
  });

  it("does not lock in a quoted sender when a later coded line has no address", () => {
    // Breaking on any coded line would return founder@ourdomain.example and a
    // hard bounce would suppress the founder's own address.
    const msg = dsn({
      humanText: [
        "Delivery failed for one recipient.",
        "",
        "From: founder@ourdomain.example",
        "To: target@dead.example",
        "",
        "The remote server returned:",
        "550 5.1.1 User unknown",
      ].join("\n"),
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("target@dead.example");
  });

  it("classifies on the full prose, not the truncated diagnostic", () => {
    // A bare SMTP code past the 300-char truncation point would otherwise be
    // invisible to classifyBounce, defaulting to soft and never suppressing.
    const padding = "This message could not be delivered. ".repeat(12);
    const msg = dsn({
      humanText: `Delivery failed for target@dead.example\n${padding}\nRemote said: 550 No such user`,
    });
    const out = parseBounce(msg)[0];
    expect(out?.kind).toBe("hard");
    // …while the STORED diagnostic stays truncated.
    expect(out?.diagnostic?.length).toBe(300);
  });

  it("still parses when the body is enormous", () => {
    // Scanning is capped; the verdict must come from the leading prose.
    const msg = dsn({
      humanText: `550 5.1.1 <target@dead.example>: User unknown\n${"!".repeat(50_000)}`,
    });
    expect(parseBounce(msg)[0]).toMatchObject({ recipient: "target@dead.example", kind: "hard" });
  });

  it("returns quickly on a hostile body with no address", () => {
    // Bounded quantifiers + scan cap: a long run of local-part characters with
    // no '@' must not blow up backtracking.
    const msg = dsn({ humanText: `550 failure\n${"!".repeat(60_000)}` });
    const started = Date.now();
    expect(parseBounce(msg)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("parseBounce — recipient scoring", () => {
  it("never picks an address off a From:/Return-Path: header", () => {
    const msg = dsn({
      humanText:
        [
          "Your message could not be delivered.",
          "From: founder@ourdomain.example",
          "Return-Path: bounce@ourdomain.example",
          "To: target@dead.example",
        ].join("\n") + "\n550 failure",
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("target@dead.example");
  });

  it("prefers the SMTP response line over an earlier To: header", () => {
    const msg = dsn({
      humanText: [
        "To: listed-first@corp.example",
        "550 5.1.1 <actually-failed@corp.example>: User unknown",
      ].join("\n"),
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("actually-failed@corp.example");
  });

  it("prefers a recipient-cue line over an incidental mention", () => {
    const msg = dsn({
      humanText: [
        "Contact support@ourdomain.example if this persists.",
        "Your message wasn't delivered to target@dead.example.",
        "The response was: 550 no such user",
      ].join("\n"),
    });
    expect(parseBounce(msg)[0]?.recipient).toBe("target@dead.example");
  });
});
