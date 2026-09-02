import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueueRow } from "../routes/queue.tsx";
import {
  bulkApprovalIds,
  drainButtonState,
  drainSelectionState,
  isQueueFilterActive,
  queuePlayList,
  queueRequest,
  queueSelectionState,
  selectVisibleQueueRows,
  toggleQueueSelection,
} from "./queue-helpers.ts";

const runnable = (playName: string): boolean => playName !== "not-runnable";

describe("queue filtering", () => {
  it("omits empty filter sentinels from the API request", () => {
    expect(queueRequest({ statusFilter: "all", playFilter: "all", orderOverride: null })).toEqual({
      limit: 200,
    });
    expect(isQueueFilterActive("pending", "all")).toBe(false);
  });

  it("retains explicit filters and combines visible and approved plays", () => {
    expect(
      queueRequest({ statusFilter: "approved", playFilter: "alpha", orderOverride: "ranked" }),
    ).toEqual({ status: "approved", play: "alpha", order: "ranked", limit: 200 });
    expect(queuePlayList([{ playName: "beta" }, { playName: "alpha" }], { gamma: 2 })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(isQueueFilterActive("pending", "alpha")).toBe(true);
  });
});

describe("queue selection and bulk approval", () => {
  it("handles an empty queue", () => {
    expect(queueSelectionState([], new Set())).toEqual({
      count: 0,
      someSelected: false,
      allSelected: false,
    });
    expect(selectVisibleQueueRows([], true)).toEqual(new Set());
    expect(bulkApprovalIds(new Set())).toEqual([]);
  });

  it("selects visible rows only and toggles without mutating its input", () => {
    const selected = new Set([9]);
    expect(selectVisibleQueueRows([{ id: 1 }, { id: 2 }], true)).toEqual(new Set([1, 2]));
    expect(toggleQueueSelection(selected, 2)).toEqual(new Set([9, 2]));
    expect(selected).toEqual(new Set([9]));
  });

  it("bulk-approves selected ids only, including locked or sent selections", () => {
    // Status and send-lock validation remains server-owned; preserving every
    // selected id keeps the extraction from changing the requests made today.
    const selected = new Set([2, 4]);
    const mixedRows = [
      { id: 1, status: "pending", isSending: false },
      { id: 2, status: "pending", isSending: true },
      { id: 3, status: "approved", isSending: false },
      { id: 4, status: "sent", isSending: false },
    ];
    expect(mixedRows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(bulkApprovalIds(selected)).toEqual([2, 4]);
  });
});

describe("queue drain eligibility", () => {
  it.each([
    {
      name: "empty selection",
      rows: [],
      expected: { enabled: false, ids: [], label: "drain selected · none approved" },
    },
    {
      name: "mixed-status selection",
      rows: [
        { id: 1, playName: "alpha", status: "pending" },
        { id: 2, playName: "alpha", status: "approved" },
        { id: 3, playName: "alpha", status: "sent" },
      ],
      expected: { enabled: true, ids: [2], label: "drain 1 selected" },
    },
    {
      name: "drain-ineligible play",
      rows: [{ id: 7, playName: "not-runnable", status: "approved" }],
      expected: {
        enabled: false,
        ids: [7],
        label: "drain selected · not runnable here",
      },
    },
  ])("handles $name", ({ rows, expected }) => {
    expect(drainSelectionState({ selected: rows, isRunnable: runnable })).toMatchObject(expected);
  });

  it("rejects approved rows spanning multiple plays", () => {
    expect(
      drainSelectionState({
        selected: [
          { id: 1, playName: "alpha", status: "approved" },
          { id: 2, playName: "beta", status: "approved" },
        ],
        isRunnable: runnable,
      }),
    ).toMatchObject({ enabled: false, ids: [], label: "drain selected · spans 2 plays" });
  });

  it("keeps whole-queue drain disabled when no play is selected or eligible", () => {
    expect(
      drainButtonState({ playFilter: "all", approvedByPlay: {}, isRunnable: runnable }),
    ).toEqual({
      playName: null,
      approvedCount: 0,
      enabled: false,
      label: "drain — pick a play above",
    });
    expect(
      drainButtonState({
        playFilter: "not-runnable",
        approvedByPlay: { "not-runnable": 2 },
        isRunnable: runnable,
      }),
    ).toMatchObject({ enabled: false, label: "drain not-runnable · not runnable here" });
  });
});

describe("queue.tsx fixed-props render fixture", () => {
  it("keeps the queue row markup byte-identical", () => {
    const row: QueueRowView = {
      id: 431,
      playName: "repo-interest",
      payload: { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical" },
      dedupeKey: "fixture-431",
      source: "github:oneshot-agent/oneshot-gtm",
      status: "pending",
      // An empty timestamp deliberately renders the stable `—` fallback,
      // keeping this byte fixture independent of wall-clock time.
      foundAt: "",
      reviewedAt: null,
      sentAt: null,
      notes: null,
      prospectId: 431,
      lastDraft: null,
      lastDraftedAt: null,
      isSending: false,
      priority: null,
    };

    const html = renderToStaticMarkup(
      createElement(QueueRow, {
        row,
        ranked: false,
        zebra: false,
        expanded: false,
        selected: true,
        anySelected: true,
        onToggleSelect: () => undefined,
        onToggle: () => undefined,
        generating: false,
        onApprove: () => undefined,
        onReject: () => undefined,
        busy: false,
      }),
    );

    expect(html).toMatchSnapshot();
  });
});
