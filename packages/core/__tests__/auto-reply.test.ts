import { describe, expect, test } from "vitest";
import {
  autoReplyConfigOf,
  autoReplyHoldUntil,
  classifyAutoReplyFast,
  extractSuccessor,
  isDeliveryNotice,
  resolveReturnDate,
  successorFromModel,
} from "../src/auto-reply.ts";

// Real autoresponder phrasings, with names and companies made up.
const RECEIVED = "2026-11-04T09:00:00.000Z";

describe("resolveReturnDate", () => {
  test.each([
    ["I am out of office until 14th December. Please contact Mr. Pekka Virtanen", "2026-12-14"],
    [
      "I'm out of the country through November 7 with limited access to email. I'll be back on Monday, November 9.",
      "2026-11-09",
    ],
    ["I am out of the office on vacation until 4 November 2026.", "2026-11-04"],
    ["Out of office until 14.12.", "2026-12-14"],
    ["Away until Dec. 3rd", "2026-12-03"],
    ["Back on 2026-11-20.", "2026-11-20"],
  ])("%s → %s", (text, want) => {
    expect(resolveReturnDate(text, RECEIVED)).toBe(want);
  });

  test("no stated day is no date", () => {
    expect(
      resolveReturnDate("I am on medical leave and will be offline until I am back.", RECEIVED),
    ).toBeNull();
    expect(resolveReturnDate("Back next week.", RECEIVED)).toBeNull();
  });

  test("a yearless date late in the year rolls over into the next one", () => {
    expect(resolveReturnDate("I'm away until 5 January.", "2026-12-20T10:00:00.000Z")).toBe(
      "2027-01-05",
    );
    // Recently past stays in this year (an old notice read late): not a year-long hold.
    expect(resolveReturnDate("Out of office until 2 November.", RECEIVED)).toBe("2026-11-02");
  });

  test("numeric dates: a part over 12 settles the order, ambiguous slashes are skipped", () => {
    expect(resolveReturnDate("Back on 9/13", "2026-09-01T10:00:00.000Z")).toBe("2026-09-13");
    expect(resolveReturnDate("Back on 13/9", "2026-09-01T10:00:00.000Z")).toBe("2026-09-13");
    expect(resolveReturnDate("Away until 5/11", RECEIVED)).toBeNull();
    // A bare number with no keyword before it is not a date.
    expect(resolveReturnDate("Ticket 9/13 received", "2026-09-01T10:00:00.000Z")).toBeNull();
  });

  test("a weekday alone resolves to the next one after the reply", () => {
    // 2026-11-04 is a Wednesday.
    expect(resolveReturnDate("I'm away, back on Monday.", RECEIVED)).toBe("2026-11-09");
  });

  test("an unreadable received date is no date", () => {
    expect(resolveReturnDate("until 14 December", "not a date")).toBeNull();
  });
});

describe("extractSuccessor", () => {
  test("the address after a contact cue, and the name before it", () => {
    expect(
      extractSuccessor(
        "I no longer work for Kestrelworks. With any and all Kestrelworks matters please contact Aino Lehto (aino.lehto@kestrelworks.example).",
        ["old@kestrelworks.example"],
      ),
    ).toEqual({ email: "aino.lehto@kestrelworks.example", name: "Aino Lehto" });
  });

  test("the sender's own and role addresses never count", () => {
    expect(
      extractSuccessor("Mail info@kestrelworks.example or me at old@kestrelworks.example.", [
        "old@kestrelworks.example",
      ]),
    ).toBeNull();
  });

  test("a name with no address", () => {
    expect(extractSuccessor("Please contact Sam Okafor for anything urgent.")).toEqual({
      name: "Sam Okafor",
    });
  });
});

describe("successorFromModel", () => {
  const text = "Dana has left. Please reach out to Lee Park at lee.park@halyard.example.";
  test("keeps what the reply says", () => {
    expect(
      successorFromModel(text, { name: "Lee Park", email: "lee.park@halyard.example" }),
    ).toEqual({ name: "Lee Park", email: "lee.park@halyard.example" });
  });
  test("drops an address or a name the reply does not contain", () => {
    expect(successorFromModel(text, { name: "Lee Park", email: "lee@halyard.example" })).toEqual({
      name: "Lee Park",
    });
    expect(successorFromModel(text, { name: "Jordan Smith", email: null })).toBeNull();
  });
});

describe("classifyAutoReplyFast", () => {
  const read = (subject: string, body: string, kind = "auto") =>
    classifyAutoReplyFast({
      kind,
      subject,
      body,
      fromEmail: "dana@halyard.example",
      receivedAt: RECEIVED,
    });

  test("left the company, with and without a successor", () => {
    expect(read("Automatic reply", "This person no longer works at Halyard.")).toEqual({
      reason: "left_company",
      returnDate: null,
      successor: null,
      needsModel: false,
    });
    expect(
      read(
        "Automatic reply",
        "I decided to move on. Please contact Lee Park at lee.park@halyard.example.",
      ),
    ).toMatchObject({
      reason: "left_company",
      successor: { email: "lee.park@halyard.example", name: "Lee Park" },
      needsModel: false,
    });
    // A contact cue the rules cannot resolve goes to the model.
    expect(
      read("Automatic reply", "I have moved on. Please contact my colleague in sales.").needsModel,
    ).toBe(true);
  });

  test("an auto_permanent row is left_company whatever the text", () => {
    expect(read("Automatic reply", "Mailbox closed.", "auto_permanent").reason).toBe(
      "left_company",
    );
  });

  test("out of office, dated and undated", () => {
    expect(read("Out of office", "Back on 9 November.")).toMatchObject({
      reason: "out_of_office",
      returnDate: "2026-11-09",
      needsModel: false,
    });
    expect(
      read("Automatic reply", "I am on medical leave and will be offline until I am back."),
    ).toEqual({
      reason: "out_of_office",
      returnDate: null,
      successor: null,
      needsModel: false,
    });
    // A date the rules cannot read goes to the model.
    expect(read("Out of office", "Away until the 14th.").needsModel).toBe(true);
  });

  test("anything else is other, for the model to read", () => {
    expect(read("Automatic reply", "Thanks for your email, we will respond soon.")).toEqual({
      reason: "other",
      returnDate: null,
      successor: null,
      needsModel: true,
    });
  });
});

describe("isDeliveryNotice", () => {
  test("bounce notices are not a person's auto-reply", () => {
    expect(isDeliveryNotice({ from: "mailer-daemon@googlemail.com", subject: "x" })).toBe(true);
    expect(isDeliveryNotice({ from: "a@b.example", subject: "Undeliverable: hello" })).toBe(true);
    expect(
      isDeliveryNotice({ from: "a@b.example", subject: "Delivery Status Notification (Failure)" }),
    ).toBe(true);
    expect(isDeliveryNotice({ from: "a@b.example", subject: "Automatic reply: hello" })).toBe(
      false,
    );
  });
});

describe("autoReplyHoldUntil and autoReplyConfigOf", () => {
  const cfg = autoReplyConfigOf({});
  const now = new Date("2026-11-04T12:00:00.000Z");

  test("defaults, and invalid values read as defaults", () => {
    expect(cfg).toEqual({
      oooBufferDays: 2,
      undatedDelayDays: 7,
      queueSuccessor: true,
      stopOnBlock: true,
    });
    expect(
      autoReplyConfigOf({
        autoReply: { oooBufferDays: -1, undatedDelayDays: "3", queueSuccessor: false },
      }),
    ).toEqual({ oooBufferDays: 2, undatedDelayDays: 7, queueSuccessor: false, stopOnBlock: true });
  });

  test("return date plus the buffer, or now plus the undated delay", () => {
    expect(
      autoReplyHoldUntil({ reason: "out_of_office", returnDate: "2026-11-09" }, cfg, now),
    ).toBe("2026-11-11T00:00:00.000Z");
    expect(autoReplyHoldUntil({ reason: "out_of_office", returnDate: null }, cfg, now)).toBe(
      "2026-11-11T12:00:00.000Z",
    );
    expect(autoReplyHoldUntil({ reason: "left_company", returnDate: null }, cfg, now)).toBeNull();
  });
});
