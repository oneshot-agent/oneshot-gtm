import { describe, expect, it } from "vitest";
import type { CadenceView } from "@oneshot-gtm/shared-types";
import {
  cadenceFilterCounts,
  cadenceStepOf,
  filterCadences,
  isOverdueCadence,
  matchesCadenceDue,
  parseCadenceFilterSearch,
} from "../src/lib/cadenceFilter.ts";

const NOW = "2026-11-12T12:00:00.000Z";

let nextId = 1;
const row = (overrides: Partial<CadenceView> = {}): CadenceView =>
  ({
    prospectId: nextId++,
    playName: "accelerator-batch",
    status: "active",
    nextStepChannel: "email",
    nextStepId: "email:1",
    nextStepIsBreakup: false,
    linkedinWaitingSince: null,
    linkedinInviteExpiresOn: null,
    nextDueAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  }) as CadenceView;

const invite = (o: Partial<CadenceView> = {}) =>
  row({ nextStepChannel: "linkedin", nextStepId: "linkedin:invite", ...o });
const waiting = (o: Partial<CadenceView> = {}) =>
  row({
    nextStepChannel: "linkedin",
    nextStepId: "linkedin:1",
    linkedinWaitingSince: "2026-10-27",
    linkedinInviteExpiresOn: "2026-11-17",
    ...o,
  });
const message = (o: Partial<CadenceView> = {}) =>
  row({ nextStepChannel: "linkedin", nextStepId: "linkedin:1", ...o });
const breakup = (o: Partial<CadenceView> = {}) =>
  row({ nextStepChannel: "linkedin", nextStepId: "linkedin:2", nextStepIsBreakup: true, ...o });

describe("cadenceStepOf", () => {
  it("names each LinkedIn step by its id, and the mail and email steps by channel", () => {
    expect(cadenceStepOf(invite())).toBe("linkedin-invite");
    expect(cadenceStepOf(waiting())).toBe("linkedin-waiting");
    expect(cadenceStepOf(message())).toBe("linkedin-message");
    expect(cadenceStepOf(breakup())).toBe("linkedin-breakup");
    expect(cadenceStepOf(row())).toBe("email");
    expect(cadenceStepOf(row({ nextStepChannel: "direct_mail", nextStepId: null }))).toBe(
      "direct-mail",
    );
  });

  it("gives an ended cadence, or one with no next step, no step", () => {
    expect(cadenceStepOf(message({ status: "replied" }))).toBeNull();
    expect(cadenceStepOf(row({ nextStepChannel: null }))).toBeNull();
  });
});

describe("due", () => {
  it("never calls a row waiting for acceptance overdue, however old its date", () => {
    const old = waiting({ nextDueAt: "2026-10-29T00:00:00.000Z" });
    expect(isOverdueCadence(old, NOW)).toBe(false);
    expect(matchesCadenceDue(old, "later", NOW)).toBe(true);
    expect(isOverdueCadence(message({ nextDueAt: "2026-11-12T11:00:00.000Z" }), NOW)).toBe(true);
  });

  it("splits sendable rows into overdue, due in 24h and later", () => {
    const soon = message({ nextDueAt: "2026-11-13T06:00:00.000Z" });
    const later = message({ nextDueAt: "2026-11-14T00:00:00.000Z" });
    expect(matchesCadenceDue(soon, "soon", NOW)).toBe(true);
    expect(matchesCadenceDue(soon, "later", NOW)).toBe(false);
    expect(matchesCadenceDue(later, "later", NOW)).toBe(true);
    expect(matchesCadenceDue(later, "soon", NOW)).toBe(false);
  });

  it("reads the due date as a time, not as text", () => {
    // SQLite's datetime() shape: a string compare would call it earlier than NOW.
    const sqliteShape = message({ nextDueAt: "2026-11-12 18:00:00Z" });
    expect(isOverdueCadence(sqliteShape, NOW)).toBe(false);
    expect(matchesCadenceDue(sqliteShape, "soon", NOW)).toBe(true);
    expect(isOverdueCadence(message({ nextDueAt: "not a date" }), NOW)).toBe(false);
  });

  it("flags an invite withdrawn within 3 days", () => {
    expect(
      matchesCadenceDue(waiting({ linkedinInviteExpiresOn: "2026-11-15" }), "invite-expiring", NOW),
    ).toBe(true);
    expect(
      matchesCadenceDue(waiting({ linkedinInviteExpiresOn: "2026-11-16" }), "invite-expiring", NOW),
    ).toBe(false);
    expect(matchesCadenceDue(message(), "invite-expiring", NOW)).toBe(false);
  });

  it("matches only active rows on any due filter but Any", () => {
    const stopped = message({ status: "stopped", nextDueAt: "2026-11-01T00:00:00.000Z" });
    expect(matchesCadenceDue(stopped, "overdue", NOW)).toBe(false);
    expect(matchesCadenceDue(stopped, "later", NOW)).toBe(false);
    expect(matchesCadenceDue(stopped, "any", NOW)).toBe(true);
  });
});

describe("filterCadences and counts", () => {
  const rows = [
    invite({ nextDueAt: "2026-11-01T00:00:00.000Z" }),
    waiting({ nextDueAt: "2026-11-01T00:00:00.000Z" }),
    message({ nextDueAt: "2026-11-11T00:00:00.000Z" }),
    message({ nextDueAt: "2026-11-30T00:00:00.000Z" }),
    breakup(),
    row({ nextDueAt: "2026-11-10T00:00:00.000Z" }),
  ];

  it("combines the step and the due filter", () => {
    expect(filterCadences(rows, { step: "linkedin-message", due: "overdue" }, NOW)).toEqual([
      rows[2],
    ]);
    expect(filterCadences(rows, { step: "linkedin-waiting", due: "overdue" }, NOW)).toEqual([]);
    expect(filterCadences(rows, { step: "all", due: "any" }, NOW)).toEqual(rows);
  });

  it("counts each chip under the other dimension's choice", () => {
    const overdue = cadenceFilterCounts(rows, { step: "all", due: "overdue" }, NOW);
    expect(overdue.step).toMatchObject({
      all: 3,
      "linkedin-invite": 1,
      "linkedin-waiting": 0,
      "linkedin-message": 1,
      email: 1,
    });
    const messages = cadenceFilterCounts(rows, { step: "linkedin-message", due: "any" }, NOW);
    expect(messages.due).toMatchObject({ any: 2, overdue: 1, later: 1, soon: 0 });
    expect(messages.step.all).toBe(rows.length);
  });
});

describe("parseCadenceFilterSearch", () => {
  it("keeps known values and drops the rest", () => {
    expect(parseCadenceFilterSearch({ step: "linkedin-breakup", due: "overdue" })).toEqual({
      step: "linkedin-breakup",
      due: "overdue",
    });
    expect(parseCadenceFilterSearch({ step: "nope", due: 3 })).toEqual({});
    expect(parseCadenceFilterSearch({ due: "any" })).toEqual({});
  });
});
