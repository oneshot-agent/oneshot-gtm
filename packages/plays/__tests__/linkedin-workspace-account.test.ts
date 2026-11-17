import { Database } from "bun:sqlite";
import type { LinkedInOperation } from "@oneshot-gtm/core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Each workspace loads its own config and ledger, while both see the same inbox store.
// Only the provider boundary is stubbed: selectors and cadence dispatch are real.
it("two workspaces send invites, cadence messages and profile reads through their own selection", async () => {
  const originalHome = process.env["ONESHOT_GTM_HOME"]!;
  const originalWorkspace = process.env["ONESHOT_GTM_WORKSPACE"];
  try {
    for (const workspace of ["alpha", "beta"]) {
      vi.resetModules();
      process.env["ONESHOT_GTM_HOME"] = join(originalHome, workspace);
      process.env["ONESHOT_GTM_WORKSPACE"] = workspace;
      mkdirSync(process.env["ONESHOT_GTM_HOME"]!, { recursive: true });
      const core = await import("@oneshot-gtm/core");
      const cadence = await import("../src/_cadence.ts");
      const reads = await import("../../find/src/_linkedin-profile.ts");
      await import("../src/repo-interest.ts");
      const store = core.getLinkedInInboxStore();
      for (const owner of ["alpha", "beta"]) {
        store.saveAccount({
          key: `wallet:${owner}`,
          wallet: "wallet",
          workspace: owner,
          account: {
            id: owner,
            status: "connected",
            allowed_actions: ["invite", "reply", "view_profile"],
          } as never,
          sync: null,
          checkedAt: null,
          error: null,
        });
      }
      core.saveConfig({
        ...core.loadConfig(),
        linkedinContinuation: true,
        linkedin: { accountKey: `wallet:${workspace}` },
      });
      expect(core.linkedInOutreachAccount()).toMatchObject({ workspace, accountId: workspace });
      expect(core.linkedInProfileReadAccount()).toEqual({ workspace, accountId: workspace });
      const ledger = core.getLedger();
      const profile = `https://www.linkedin.com/in/person-${workspace}`;
      const prospectId = ledger.upsertProspect({
        name: "Dana Lee",
        email: `${workspace}@example.com`,
        linkedin_url: profile,
        source: "repo-interest",
      });
      const playName = "repo-interest";
      ledger.recordSequenceEvent({
        prospectId,
        playName,
        stepIndex: 0,
        channel: "email",
        status: "sent",
        metadata: { body: "Hello." },
      });
      cadence.enrollInCadence({ prospectId, playName });
      ledger.advanceCadence({
        prospectId,
        playName,
        newStep: 1,
        nextDueAt: "2000-01-01T00:00:00.000Z",
      });
      const calls: Array<{ owner: string; op: LinkedInOperation }> = [];
      const linkedIn = async (owner: string, op: LinkedInOperation) => {
        calls.push({ owner, op });
        if (op.kind === "account")
          return { limits: { invites: { limit: 25, remaining: 20, resets_at: null } } };
        if (op.kind === "invite") return { status: "sent", invitation_id: `invite-${workspace}` };
        if (op.kind === "invitation")
          return { status: "accepted", invitation_id: `invite-${workspace}` };
        if (op.kind === "message") return { status: "sent", conversation_id: `chat-${workspace}` };
        if (op.kind === "profile-read")
          return {
            status: "completed",
            result: {
              profile: { name: "Dana Lee", experience: [{ company: "Acme", title: "Engineer" }] },
            },
          };
        throw new Error(`unexpected ${op.kind}`);
      };
      const invite = await cadence.runCadenceStepForProspect({
        prospectId,
        playName,
        dryRun: false,
        persistedPayload: { kind: "linkedin_invite", note: "Hi Dana, good to meet you." },
        linkedIn,
      });
      expect(invite.action).toBe("step-sent");
      expect(calls.find((c) => c.op.kind === "invite")).toMatchObject({
        owner: workspace,
        op: { accountId: workspace },
      });
      const db = new Database(join(process.env["ONESHOT_GTM_HOME"]!, "ledger.sqlite"));
      db.exec(
        "UPDATE sequence_events SET created_at = datetime('now', '-3 days') WHERE channel = 'linkedin'",
      );
      db.close();
      ledger.advanceCadence({
        prospectId,
        playName,
        newStep: 2,
        nextDueAt: "2000-01-01T00:00:00.000Z",
      });
      const message = await cadence.runCadenceStepForProspect({
        prospectId,
        playName,
        dryRun: false,
        persistedPayload: { kind: "linkedin_message", text: "Hello again." },
        linkedIn,
      });
      expect(message.action).toBe("step-sent");
      expect(calls.find((c) => c.op.kind === "message")).toMatchObject({
        owner: workspace,
        op: { accountId: workspace },
      });
      reads._setLinkedInCall(linkedIn, 0);
      await reads.readLinkedInProfile(
        profile,
        { playName, memo: "selection test" },
        { remainingUsd: 1, opened: true },
      );
      expect(calls.find((c) => c.op.kind === "profile-read")).toMatchObject({
        owner: workspace,
        op: { accountId: workspace },
      });

      // Stored conversations must not bypass an ambiguous or unavailable selection.
      const senders = await import("../src/_linkedin-invites.ts");
      core.saveConfig({ ...core.loadConfig(), linkedin: {} });
      expect(senders.linkedInSenderFor(prospectId, playName)).toBeNull();
      expect(senders.storedLinkedInConversation(prospectId, playName)).toBeNull();
      expect(core.linkedInProfileReadAccount()).toBeNull();
      const before = calls.length;
      ledger.advanceCadence({
        prospectId,
        playName,
        newStep: 3,
        nextDueAt: "2000-01-01T00:00:00.000Z",
      });
      await cadence.runCadenceStepForProspect({
        prospectId,
        playName,
        dryRun: false,
        persistedPayload: { kind: "linkedin_message", text: "Close." },
        linkedIn,
      });
      expect(
        calls.slice(before).filter((c) => ["message", "reply", "invite"].includes(c.op.kind)),
      ).toEqual([]);
      reads._setLinkedInCall(null);
      ledger.close();
      store.db.close();
    }
  } finally {
    process.env["ONESHOT_GTM_HOME"] = originalHome;
    if (originalWorkspace === undefined) delete process.env["ONESHOT_GTM_WORKSPACE"];
    else process.env["ONESHOT_GTM_WORKSPACE"] = originalWorkspace;
    vi.resetModules();
  }
}, 30_000);
