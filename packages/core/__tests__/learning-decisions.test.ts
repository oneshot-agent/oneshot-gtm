import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { decideLearning, recoverLearningApplications } from "../src/learning-decisions.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { normalizeIcpText } from "../src/icp-proposal-store.ts";
import { draftLearningContext } from "../src/draft-learning.ts";

let ledger: Ledger;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "learning-decisions-"));
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  saveConfig({ ...loadConfig(), icpOneLiner: "old ICP" });
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});
const propose = (value = "new ICP") =>
  ledger.learning.insert({
    kind: "icp",
    current: "old ICP",
    proposed: value,
    evidence: { refs: [] },
    evidenceSummary: "explicit fit",
    baselineKey: normalizeIcpText("old ICP"),
    dedupeKey: value,
  })!;

it("a newer manual edit cannot be overwritten by rollback", () => {
  const p = propose();
  decideLearning(ledger, p.id, "approve");
  saveConfig({ ...loadConfig(), icpOneLiner: "manually changed" });
  expect(() => decideLearning(ledger, p.id, "rollback")).toThrow(/changed/);
  expect(loadConfig().icpOneLiner).toBe("manually changed");
  expect(ledger.learning.get(p.id)?.status).toBe("approved");
});
it("recovers a config write interrupted before the ledger commit", () => {
  const p = propose();
  ledger.learning.db
    .query("INSERT INTO learning_applications VALUES(?,?,?,?,?)")
    .run(
      p.id,
      "approve",
      JSON.stringify("new ICP"),
      JSON.stringify("old ICP"),
      "2026-10-08T10:00:00Z",
    );
  saveConfig({ ...loadConfig(), icpOneLiner: "new ICP" });
  recoverLearningApplications(ledger);
  expect(ledger.learning.get(p.id)).toMatchObject({
    status: "approved",
    appliedAt: "2026-10-08T10:00:00Z",
  });
  expect(ledger.learning.db.query("SELECT * FROM learning_applications").all()).toEqual([]);
  recoverLearningApplications(ledger);
  decideLearning(ledger, p.id, "rollback");
  expect(loadConfig().icpOneLiner).toBe("old ICP");
});
it("abandons an intent interrupted before writing config, preserving a retry", () => {
  const p = propose();
  ledger.learning.db
    .query("INSERT INTO learning_applications VALUES(?,?,?,?,?)")
    .run(
      p.id,
      "approve",
      JSON.stringify("new ICP"),
      JSON.stringify("old ICP"),
      "2026-10-08T10:00:00Z",
    );
  recoverLearningApplications(ledger);
  expect(ledger.learning.get(p.id)?.status).toBe("pending");
  decideLearning(ledger, p.id, "approve");
  expect(loadConfig().icpOneLiner).toBe("new ICP");
});
it("does not overwrite a conflicting edit while recovering", () => {
  const p = propose();
  ledger.learning.db
    .query("INSERT INTO learning_applications VALUES(?,?,?,?,?)")
    .run(
      p.id,
      "approve",
      JSON.stringify("new ICP"),
      JSON.stringify("old ICP"),
      "2026-10-08T10:00:00Z",
    );
  saveConfig({ ...loadConfig(), icpOneLiner: "manual" });
  expect(() => recoverLearningApplications(ledger)).toThrow(/conflicts/);
  expect(loadConfig().icpOneLiner).toBe("manual");
});
it("retains immutable attribution after guidance and ICP change", () => {
  const g = ledger.learning.addGuidance({
    instruction: "Be brief",
    source: "explicit",
    channel: "email",
    stage: "reply",
  });
  const input = { channel: "email" as const, stage: "reply" as const };
  const first = draftLearningContext(ledger, input);
  ledger.learning.setGuidanceEnabled(g.id, false);
  saveConfig({ ...loadConfig(), icpOneLiner: "new ICP" });
  const next = draftLearningContext(ledger, input);
  expect(next.key).not.toBe(first.key);
  expect(ledger.learning.context(first.key)).toMatchObject({
    icp: "old ICP",
    guidance: [{ id: g.id, instruction: "Be brief" }],
  });
  expect(ledger.learning.context(next.key)).toMatchObject({ icp: "new ICP", guidance: [] });
});

it.each(["email", "linkedin"] as const)(
  "keeps existing angles and scopes guidance across every %s stage",
  (channel) => {
    const id = ledger.upsertProspect({ email: "known@example.test", name: "Known" });
    ledger.setProspectAngle(id, JSON.stringify({ hook: "existing", nextStep: "ask" }));
    const stages = ["first_touch", "follow_up", "reply"] as const;
    for (const stage of stages)
      ledger.learning.addGuidance({
        instruction: `only ${stage}`,
        source: "explicit",
        channel,
        stage,
      });
    for (const stage of stages) {
      const result = draftLearningContext(ledger, { channel, stage, prospectId: id });
      expect(result.context.prospectAngle).toContain("existing");
      expect(result.instructions.map((i) => i.instruction)).toEqual([`only ${stage}`]);
      expect(ledger.getProspectById(id)?.angle_approved_at).toBeNull();
    }
    expect(
      draftLearningContext(ledger, { channel, stage: "reply", email: "unrelated@example.test" })
        .context.prospectAngle,
    ).toBeNull();
  },
);
it("serializes competing approvals from separate processes", async () => {
  const a = propose("first ICP");
  const b = propose("second ICP");
  const module = new URL("../src/learning-decisions.ts", import.meta.url).pathname;
  const ledgerModule = new URL("../src/ledger.ts", import.meta.url).pathname;
  const code = `import {Ledger} from ${JSON.stringify(ledgerModule)}; import {decideLearning} from ${JSON.stringify(module)}; const ledger=new Ledger(process.argv[1]); try {decideLearning(ledger,process.argv[2],"approve");console.log("ok");} catch(e) {console.log(e.status ?? "error");} finally {ledger.close();}`;
  const children = [a, b].map((p) =>
    Bun.spawn([process.execPath, "-e", code, join(dir, "ledger.sqlite"), p.id], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    children.map(async (p) => {
      const output = await new Response(p.stdout).text();
      const error = await new Response(p.stderr).text();
      expect(await p.exited, error).toBe(0);
      return output.trim();
    }),
  );
  expect(results.toSorted()).toEqual(["409", "ok"]);
  expect(ledger.learning.list({ kind: "icp", status: "approved" })).toHaveLength(1);
});

it("shares only the matched prospect's channel history", () => {
  const known = ledger.upsertProspect({ email: "known-history@example.test", name: "Known" });
  const other = ledger.upsertProspect({ email: "other-history@example.test", name: "Other" });
  ledger.learning.db
    .query(
      "INSERT INTO channel_events(source,external_event_id,prospect_id,channel,event_type,occurred_at,body) VALUES(?,?,?,'linkedin','reply',?,?)",
    )
    .run("test", "one", known, "2026-10-08", "Known's reply");
  ledger.learning.db
    .query(
      "INSERT INTO channel_events(source,external_event_id,prospect_id,channel,event_type,occurred_at,body) VALUES(?,?,?,'linkedin','reply',?,?)",
    )
    .run("test", "two", other, "2026-10-08", "Other's reply");
  const context = draftLearningContext(ledger, {
    channel: "email",
    stage: "reply",
    prospectId: known,
  });
  expect(context.text).toContain("Known's reply");
  expect(context.text).not.toContain("Other's reply");
  expect(
    draftLearningContext(ledger, { channel: "email", stage: "reply" }).context.relatedHistory,
  ).toEqual([]);
});
