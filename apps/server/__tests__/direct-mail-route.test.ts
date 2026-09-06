import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";
let ledger: Ledger;
const upload = vi.fn(),
  preview = vi.fn(),
  approve = vi.fn(),
  send = vi.fn();
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ founderName: "Alex" }),
    uploadMailArtwork: (...args: unknown[]) => upload(...args),
    previewDirectMail: (...args: unknown[]) => preview(...args),
    approveDirectMail: (...args: unknown[]) => approve(...args),
  };
});
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    getSequence: (playName: string, prospectId: number) => ({
      steps: ledger.getCadencePlan(
        prospectId,
        playName,
        ledger.getCadence(prospectId, playName)!.enrolled_at,
      ),
    }),
    generateMailLetter: async () => "Dear Jane,\nA letter from Alex.",
    sendDirectMailCadenceStep: (...args: unknown[]) => send(...args),
  };
});
vi.mock("../src/server.ts", () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));
const { directMailRoute } = await import("../src/api/direct-mail.ts");
const { renderMailLetter } = await import("@oneshot-gtm/core");
const address = {
  name: "Jane",
  address_line1: "1 Main St",
  address_city: "Boston",
  address_state: "MA",
  address_zip: "02110",
  address_country: "US" as const,
};
let id: number;
beforeEach(() => {
  ledger = new Ledger(":memory:");
  vi.clearAllMocks();
  id = ledger.upsertProspect({ name: "Jane", businessAddress: address });
  ledger.enrollCadence({ prospectId: id, playName: "motion", nextDueAt: new Date().toISOString() });
  ledger.saveCadencePlan(id, "motion", ledger.getCadence(id, "motion")!.enrolled_at, [
    { id: "direct_mail", channel: "direct_mail", dayOffset: 3 },
  ]);
  ledger.setMailAddress("return", { ...address, name: "Alex", address_line1: "2 Main St" });
  upload.mockResolvedValue({ asset_id: "new-file" });
  preview.mockImplementation(async (prospectId, playName, input) => ({
    id: "new-draft",
    prospectId,
    playName,
    input,
  }));
  approve.mockResolvedValue({});
  send.mockResolvedValue({ action: "step-sent" });
});
afterEach(() => ledger.close());
const post = (action: string, body: Record<string, unknown> = {}) =>
  directMailRoute(
    new Request(`http://local/api/direct-mail/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prospectId: id, playName: "motion", ...body }),
    }),
  );
function oldDraft(prospectId = id) {
  const cadence = ledger.getCadence(prospectId, "motion")!;
  ledger.saveDirectMail({
    id: `old-${prospectId}`,
    prospectId,
    playName: "motion",
    enrollment: cadence.enrolled_at,
    stepIndex: 1,
    approvalId: "old-approval",
    input: { to: address, from: address },
    quote: {},
    sendKey: "old-key",
  } as any);
}
describe("per-prospect direct mail API", () => {
  it("loads both saved addresses without generating content or creating a draft", async () => {
    const response = await directMailRoute(
      new Request(`http://local/api/direct-mail?prospectId=${id}&playName=motion`),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.address.name).toBe("Jane");
    expect(result.returnAddress.name).toBe("Alex");
    expect(ledger.listDirectMail()).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });
  it("binds an upload to one prospect and discards only that prospect’s old approval", async () => {
    oldDraft();
    const other = ledger.upsertProspect({ name: "Other" });
    ledger.enrollCadence({
      prospectId: other,
      playName: "motion",
      nextDueAt: new Date().toISOString(),
    });
    oldDraft(other);
    const bytes = await renderMailLetter("Uploaded artwork");
    const response = await directMailRoute(
      new Request(
        `http://local/api/direct-mail/upload?prospectId=${id}&playName=motion&filename=letter.pdf`,
        { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes as BodyInit },
      ),
    );
    expect(response.status).toBe(200);
    expect(upload.mock.calls[0]![0]).toEqual(bytes);
    expect(ledger.getDirectMail(`old-${id}`)).toBeNull();
    expect(ledger.getDirectMail(`old-${other}`)?.approvalId).toBe("old-approval");
    const c = ledger.getCadence(id, "motion")!;
    expect(ledger.getMailPreparation(id, "motion", c.enrolled_at, 1)).toEqual({
      mode: "upload",
      assetId: "new-file",
      filename: "letter.pdf",
    });
    expect((await post("preview")).status).toBe(200);
    expect(preview.mock.calls[0]![2]).toMatchObject({
      to: address,
      from: { name: "Alex" },
      artwork: { kind: "letter", file: "new-file" },
    });
  });
  it("keeps the existing draft available when previewing saved artwork", async () => {
    oldDraft();
    const c = ledger.getCadence(id, "motion")!;
    ledger.saveMailPreparation(id, "motion", c.enrolled_at, 1, {
      mode: "upload",
      assetId: "saved-file",
    });
    preview.mockImplementationOnce(async () => {
      expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
      return { id: `old-${id}` };
    });
    expect((await post("preview")).status).toBe(200);
    expect(preview).toHaveBeenCalledTimes(1);
  });
  it("does not discard a proof when the editor saves unchanged letter text", async () => {
    oldDraft();
    const c = ledger.getCadence(id, "motion")!;
    ledger.saveMailPreparation(id, "motion", c.enrolled_at, 1, {
      mode: "generated",
      body: "Same letter",
    });
    expect((await post("save-letter", { body: "Same letter" })).status).toBe(200);
    expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
  });
  it("persists generated edits and invalidates the old proof", async () => {
    oldDraft();
    expect((await post("save-letter", { body: "My revised letter" })).status).toBe(200);
    expect(ledger.getDirectMail(`old-${id}`)).toBeNull();
    const c = ledger.getCadence(id, "motion")!;
    expect(ledger.getMailPreparation(id, "motion", c.enrolled_at, 1)?.body).toBe(
      "My revised letter",
    );
  });
  it("preserves the previous proof when letter validation fails", async () => {
    oldDraft();
    expect((await post("save-letter", { body: "" })).status).toBe(400);
    expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
    expect((await post("save-letter", { body: "x".repeat(500) })).status).toBe(400);
    expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
  });
  it("preserves the previous proof when artwork upload fails", async () => {
    oldDraft();
    upload.mockRejectedValueOnce(new Error("Upload unavailable"));
    const bytes = await renderMailLetter("Replacement artwork");
    const response = await directMailRoute(
      new Request(`http://local/api/direct-mail/upload?prospectId=${id}&playName=motion`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: bytes as BodyInit,
      }),
    );
    expect(response.status).toBe(400);
    expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
  });
  it("rejects an upload if the enrollment changes while it is in flight", async () => {
    oldDraft();
    upload.mockImplementationOnce(async () => {
      ledger.advanceCadence({ prospectId: id, playName: "motion", newStep: 1, nextDueAt: null });
      return { asset_id: "stale-file" };
    });
    const bytes = await renderMailLetter("Replacement artwork");
    const response = await directMailRoute(
      new Request(`http://local/api/direct-mail/upload?prospectId=${id}&playName=motion`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: bytes as BodyInit,
      }),
    );
    expect(response.status).toBe(400);
    expect(ledger.getCadence(id, "motion")?.current_step).toBe(1);
    expect(ledger.getDirectMail(`old-${id}`)?.approvalId).toBe("old-approval");
  });
  it("blocks preparation for email steps and leaves missing-address mail pending", async () => {
    const c = ledger.getCadence(id, "motion")!;
    ledger.saveCadencePlan(id, "motion", c.enrolled_at, [
      { id: "base:1", channel: "email", dayOffset: 3 },
    ]);
    expect((await post("preview")).status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
    ledger.saveCadencePlan(id, "motion", c.enrolled_at, [
      { id: "direct_mail", channel: "direct_mail", dayOffset: 3 },
    ]);
    const missing = ledger.upsertProspect({ name: "Missing" });
    ledger.enrollCadence({
      prospectId: missing,
      playName: "motion",
      nextDueAt: new Date().toISOString(),
    });
    ledger.saveCadencePlan(missing, "motion", ledger.getCadence(missing, "motion")!.enrolled_at, [
      { id: "direct_mail", channel: "direct_mail", dayOffset: 3 },
    ]);
    expect((await post("preview", { prospectId: missing })).status).toBe(400);
    expect(ledger.getCadence(missing, "motion")!.current_step).toBe(0);
  });
  it("combines individual approval and sending and releases the send lock", async () => {
    oldDraft();
    const response = await post("approve-send", {
      id: `old-${id}`,
      approval: { approved: true, input_hash: "hash", total_usdc: "1" },
    });
    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(`old-${id}`);
    expect(ledger.getCadence(id, "motion")!.sending_started_at).toBeNull();
  });
});
