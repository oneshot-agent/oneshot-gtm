import type { RepliesResult, ReplyThread, ReplyDraftSet } from "@oneshot-gtm/shared-types";

/** Fictional network-read fixture, isolated from the operator's shared LinkedIn store. */
export function buildLinkedInDemo(
  anchor: Date,
  prospects: Array<{ id: number; email: string; name: string; company: string | null }>,
): Pick<RepliesResult, "threads" | "accounts"> {
  const at = (hours: number) => new Date(anchor.getTime() - hours * 3_600_000).toISOString();
  const accounts: RepliesResult["accounts"] = [
    {
      key: "demo-linkedin-mira",
      id: "demo_li_account",
      name: "Mira Vance",
      workspace: "demo",
      status: "connected",
      syncState: "ready",
      complete: true,
      lastCheckedAt: at(0.1),
      error: null,
      canReply: true,
      canResolve: true,
    },
    {
      key: "demo-linkedin-previous",
      id: "demo_li_previous",
      name: "Mira Vance · previous connection",
      workspace: "demo",
      status: "disconnected",
      syncState: "reconnect_required",
      complete: true,
      lastCheckedAt: at(48),
      error: "This demo connection needs to be reconnected.",
      canReply: false,
    },
  ];
  const examples = [
    {
      email: "rae@stellar.dev",
      hours: 1,
      body: "We can see handler time, but time waiting for a worker disappears between retries. Does Tracepoint keep the same trace across attempts?",
      outbound:
        "Your worker-tracing thread made me wonder whether queue wait and handler time show up separately. We record both in Tracepoint.",
      state: "active",
    },
    {
      email: "nils@fenwick.sh",
      hours: 4,
      body: "We are in the middle of the reliability hire. Could you come back next week with the worker instrumentation example?",
      outbound:
        "I saw the founding reliability work at Fenwick. A small worker example might be more useful than a deck.",
      state: "snoozed",
    },
    {
      email: "sam@beacon.run",
      hours: 26,
      body: "Thanks, that answers it. We are keeping our current setup for now.",
      outbound:
        "Here is how we separate the recorded job history from replay. Happy to leave it there if your current traces cover it.",
      state: "archived",
    },
    {
      name: "Lea Moreno",
      company: "Relay Works",
      hours: 2,
      body: "A friend sent me your post on retry traces. Does this work with Python workers?",
      outbound: "",
      state: "unmatched",
    },
    {
      name: "LinkedIn member",
      company: null,
      hours: 3,
      body: "Could you share the background-job tracing example from your post?",
      outbound: "",
      state: "unresolved",
    },
    {
      email: "ines@baseplate.dev",
      hours: 30,
      body: "We have a staging queue ready. What would you need from us to try the instrumentation?",
      outbound:
        "A staging worker is enough to start. We can look at one retry chain before touching production.",
      state: "disconnected",
    },
  ];
  const threads: ReplyThread[] = examples.map((example, i) => {
    const prospect = example.email ? prospects.find((p) => p.email === example.email) : undefined;
    if (example.email && !prospect)
      throw new Error(`Missing LinkedIn demo prospect: ${example.email}`);
    const missing = example.state === "unresolved";
    const disconnected = example.state === "disconnected";
    const name = prospect?.name ?? example.name!;
    const profileUrl = missing
      ? null
      : `https://www.linkedin.com/in/${name.toLowerCase().replaceAll(" ", "-")}-demo`;
    const key = `linkedin:demo-conversation-${i + 1}`;
    const contextVersion = `demo-context-${i + 1}`;
    let drafts: ReplyDraftSet | null = null;
    if (i === 0) {
      const options = {
        direct:
          "Yes. The retry keeps its parent span, so you can see the wait before each attempt and the handler time separately. I can send a small worker example.",
        technical:
          "We carry the parent span through the retry metadata. Each attempt gets its own child span, with queue wait recorded separately from handler execution. Do your workers preserve job metadata when it reschedules?",
        warm: "That gap between retries is why I started building this. We keep the attempts on one trace and show where the waiting happened. Happy to share a small example you can inspect.",
      };
      drafts = {
        id: "demo-linkedin-drafts-1",
        revision: 1,
        contextVersion,
        read: "Rae wants to know whether retry attempts keep their tracing context.",
        originals: options,
        edits: { ...options },
        moves: {},
        flags: { direct: [], technical: [], warm: [] },
        setFlags: [],
        selected: "technical",
        steer: "",
        generated: true,
      };
    }
    return {
      key,
      channel: "linkedin",
      name,
      company: prospect?.company ?? example.company ?? null,
      subject: "LinkedIn conversation",
      address: profileUrl ?? "",
      profileUrl,
      workspace: prospect ? "demo" : null,
      prospectId: prospect?.id ?? null,
      messages: [
        ...(example.outbound
          ? [
              {
                id: `${key}:out`,
                direction: "outbound" as const,
                body: example.outbound,
                at: at(example.hours + 8),
                human: true,
              },
            ]
          : []),
        {
          id: `${key}:in`,
          direction: "inbound" as const,
          body: example.body,
          at: at(example.hours),
          human: true,
        },
      ],
      lastActivityAt: at(example.hours),
      archivedAt: example.state === "archived" ? at(24) : null,
      snoozedUntil: example.state === "snoozed" ? at(-120) : null,
      needsReply: example.state !== "archived",
      canSend: !disconnected,
      canGenerate: !!prospect && !disconnected,
      unavailableReason: disconnected
        ? "Reconnect this account before replying."
        : !prospect
          ? "Assign a workspace and prospect to generate replies."
          : undefined,
      contextVersion,
      drafts,
      send: null,
      accountKey: accounts[disconnected ? 1 : 0]!.key,
      conversationId: `demo-conversation-${i + 1}`,
      historyComplete: true,
      matchStatus: prospect ? "matched" : missing ? "missing_identity" : "no_prospect",
    };
  });
  return { threads, accounts };
}
