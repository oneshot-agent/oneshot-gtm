import { describe, expect, test } from "vitest";
import { classifyReply, stripQuotedChain } from "../src/reply-classify.ts";

describe("classifyReply", () => {
  test("plain human reply is human", () => {
    expect(
      classifyReply({
        subject: "Re: trustclaw stack",
        body: "It's too soon for me to grant payment access to an agent but thank you for the offer.",
      }),
    ).toBe("human");
  });

  // The real payload that inflated the reply metric on 2026-08-27: a Chinese
  // vacation autoresponder ("自动回复:" = "Automatic reply:").
  test("自动回复 subject prefix is auto", () => {
    expect(
      classifyReply({
        subject: "自动回复: nanoclaw and egress holes",
        body: "山东尚家具欢迎您\nwww.sjiaju.com",
      }),
    ).toBe("auto");
  });

  // The other real payload: OOO responder announcing the mailbox is dead.
  test("out-of-office with a retirement notice is auto_permanent", () => {
    expect(
      classifyReply({
        subject: "out of office Re: your puppeteer setup",
        body: "Retired October 2025.  No longer using this email.",
      }),
    ).toBe("auto_permanent");
  });

  test("header verdict alone classifies as auto (subject/body give no hint)", () => {
    expect(
      classifyReply({
        subject: "Re: your ses setup",
        body: "Thanks for your message. I will respond when I return.",
        autoSubmitted: true,
      }),
    ).toBe("auto");
  });

  test("header verdict plus permanence phrase escalates to auto_permanent", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Jane has left the company. Please contact support@example.com.",
        autoSubmitted: true,
      }),
    ).toBe("auto_permanent");
  });

  test("multilingual subject prefixes are auto", () => {
    for (const subject of [
      "Automatic reply: your millrace runtime",
      "Auto-Reply: hi",
      "Out of Office: hello",
      "Abwesenheitsnotiz: Re: intro",
      "Réponse automatique : votre message",
      "Respuesta automática: hola",
      "自動回覆: 您好",
    ]) {
      expect(classifyReply({ subject, body: "" })).toBe("auto");
    }
  });

  test("OOO phrasing at the top of the body is auto", () => {
    expect(
      classifyReply({
        subject: "Re: stack thing",
        body: "I am out of the office until Sept 8 with limited access to email.",
      }),
    ).toBe("auto");
  });

  test("on-leave phrasing is auto", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "I'm on parental leave until January and will reply after that.",
      }),
    ).toBe("auto");
  });

  test("mentioning a past vacation deep in a long reply stays human", () => {
    const body =
      "Hey, thanks for the nudge — this got buried. " +
      "We shipped the migration last week and the numbers look right. " +
      "Happy to do a call: what does your Thursday look like? " +
      "Also apologies for the silence, " +
      "x".repeat(400) +
      " I was out of office for two weeks in July.";
    expect(classifyReply({ subject: "Re: your ses setup", body })).toBe("human");
  });

  test("'out of ideas' is not out of office", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Honestly I'm out of ideas on the vendor sprawl front — curious what you'd do.",
      }),
    ).toBe("human");
  });

  test("quoting an OOO inside a human reply stays human", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Back now, let's talk.\n\nOn Wed, Aug 20, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> I am out of the office until Monday.",
      }),
    ).toBe("human");
  });

  test("explicit removal requests are unsubscribe", () => {
    for (const body of [
      "Please remove me from your list.",
      "unsubscribe",
      "Do not contact me again.",
      "Stop emailing me.",
      "Take me off this list please",
      "Not interested — please remove me.",
    ]) {
      expect(classifyReply({ subject: "Re: intro", body })).toBe("unsubscribe");
    }
  });

  test("a human apologizing for a PAST absence stays human", () => {
    for (const body of [
      "Sorry — I was out of the office last week, back now. Happy to talk.",
      "Apologies, I've been on vacation. What did you have in mind?",
      "I was away from my email for a few days. Still interested?",
    ]) {
      expect(classifyReply({ subject: "Re: your ses setup", body })).toBe("human");
    }
  });

  test("a subject-only unsubscribe with an empty body is unsubscribe", () => {
    expect(classifyReply({ subject: "Unsubscribe", body: "" })).toBe("unsubscribe");
    expect(classifyReply({ subject: "Please remove me", body: "" })).toBe("unsubscribe");
  });

  test("an opt-out inside a vacation-style human note wins over the OOO phrasing", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Heading out on vacation — please remove me from your list.",
      }),
    ).toBe("unsubscribe");
  });

  test("header-verdict machine mail is never an unsubscribe, even with the word in it", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "I am out of the office. To unsubscribe from these notifications click here.",
        autoSubmitted: true,
      }),
    ).toBe("auto");
  });

  test("a bare soft no stays human", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Not interested right now, but ping me next quarter.",
      }),
    ).toBe("human");
  });

  test("our own footer in the quoted chain does not trigger unsubscribe", () => {
    expect(
      classifyReply({
        subject: "Re: intro",
        body: "Sounds interesting, tell me more.\n\nOn Tue, JN wrote:\n> ...\n> Reply unsubscribe to opt out.",
      }),
    ).toBe("human");
  });

  test("empty subject and body default to human", () => {
    expect(classifyReply({})).toBe("human");
  });
});

describe("stripQuotedChain (moved from plays/reply.ts)", () => {
  test("cuts at the attribution line", () => {
    expect(stripQuotedChain("New text.\nOn Mon, Jane wrote:\n> old")).toBe("New text.");
  });
  test("cuts at the first quoted run", () => {
    expect(stripQuotedChain("New text.\n> old\n> older")).toBe("New text.");
  });
  test("passes plain bodies through", () => {
    expect(stripQuotedChain("Just a reply.")).toBe("Just a reply.");
  });
});
