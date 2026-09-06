import {
  getLedger,
  loadConfig,
  uploadMailArtwork,
  previewDirectMail,
  refreshDirectMail,
  approveDirectMail,
  cancelDirectMail,
  requireMailAddress,
  letterArtworkPdf,
  renderMailLetter,
  type MailPreparation,
} from "@oneshot-gtm/core";
import {
  sendDirectMailCadenceStep,
  getSequence,
  skipDirectMailStep,
  generateMailLetter,
  researchBusinessAddress,
} from "@oneshot-gtm/plays";
import { readMailArtwork } from "./mail-artwork.ts";
import { jsonResponse } from "../server.ts";

function identity(body: { prospectId?: unknown; playName?: unknown }) {
  const prospectId = Number(body.prospectId),
    playName = body.playName;
  if (!Number.isInteger(prospectId) || prospectId < 1 || typeof playName !== "string" || !playName)
    throw new Error("A prospect and motion are required");
  return { prospectId, playName };
}
function context(input: ReturnType<typeof identity>, requirePending = false) {
  const ledger = getLedger();
  const cadence = ledger.getCadence(input.prospectId, input.playName);
  if (!cadence) throw new Error("Cadence not found");
  const draft = ledger.findDirectMail(
    input.prospectId,
    input.playName,
    cadence.enrolled_at,
    cadence.current_step + 1,
  );
  const configuredMail =
    getSequence(input.playName, input.prospectId)?.steps[cadence.current_step]?.channel ===
    "direct_mail";
  if (requirePending && (cadence.status !== "active" || !configuredMail))
    throw new Error("The next cadence step is not direct mail");
  return {
    cadence,
    configuredMail,
    draft,
    preparation: ledger.getMailPreparation(
      input.prospectId,
      input.playName,
      cadence.enrolled_at,
      cadence.current_step + 1,
    ),
  };
}
function invalidate(input: ReturnType<typeof identity>) {
  const { cadence, draft } = context(input, true);
  if (cadence.sending_started_at || draft?.started)
    throw new Error("Recover the existing submission before changing this mailpiece");
  if (draft) getLedger().deleteDirectMail(draft.id);
  getLedger().clearCadenceDraft(input);
}
function savePreparation(
  input: ReturnType<typeof identity>,
  original: ReturnType<typeof context>,
  preparation: MailPreparation,
) {
  const current = context(input, true);
  if (
    current.cadence.enrolled_at !== original.cadence.enrolled_at ||
    current.cadence.current_step !== original.cadence.current_step
  )
    throw new Error("Cadence changed; reopen this prospect’s mail step");
  invalidate(input);
  getLedger().saveMailPreparation(
    input.prospectId,
    input.playName,
    current.cadence.enrolled_at,
    current.cadence.current_step + 1,
    preparation,
  );
  return preparation;
}
const busy = new Set<string>();
export async function directMailRoute(req: Request): Promise<Response> {
  let lock: string | undefined;
  try {
    const ledger = getLedger(),
      url = new URL(req.url);
    if (req.method === "GET") {
      const input = url.searchParams.has("prospectId")
        ? identity({
            prospectId: url.searchParams.get("prospectId"),
            playName: url.searchParams.get("playName"),
          })
        : null;
      return jsonResponse(
        {
          drafts: ledger
            .listDirectMail()
            .filter(
              (d) => !input || (d.prospectId === input.prospectId && d.playName === input.playName),
            ),
          returnAddress: ledger.getMailAddress("return"),
          founderName: loadConfig().founderName,
          ...(input
            ? {
                ...context(input),
                address: ledger.getMailAddress(`prospect:${input.prospectId}`),
                addressSource: ledger.getMailAddressMetadata(`prospect:${input.prospectId}`),
                prospect: ledger.getProspectById(input.prospectId),
              }
            : {}),
        },
        200,
        req,
      );
    }
    const action = url.pathname.split("/").pop();
    const body = action === "upload" ? Object.fromEntries(url.searchParams) : await req.json();
    const existing = typeof body.id === "string" ? ledger.getDirectMail(body.id) : null;
    const input = existing
      ? { prospectId: existing.prospectId, playName: existing.playName }
      : body.prospectId != null
        ? identity(body)
        : null;
    lock = input ? `${input.prospectId}|${input.playName}` : "return-address";
    if (busy.has(lock)) {
      lock = undefined;
      return jsonResponse(
        { error: "This mailpiece is being updated; try again shortly" },
        409,
        req,
      );
    }
    busy.add(lock);
    if (action === "return-address") {
      const address = requireMailAddress(body.address);
      ledger.setMailAddress("return", address);
      return jsonResponse({ address }, 200, req);
    }
    if (action === "upload") {
      const mime = req.headers.get("content-type") ?? "";
      const bytes = await readMailArtwork(req);
      // Keep the existing unscoped artwork API for legacy postcard/CLI workflows.
      if (!input) {
        if (!["application/pdf", "image/jpeg", "image/png"].includes(mime))
          throw new Error("Unsupported artwork format");
        return jsonResponse(
          await uploadMailArtwork(bytes, mime as "application/pdf" | "image/jpeg" | "image/png"),
          200,
          req,
        );
      }
      const original = context(input, true);
      const pdf = await letterArtworkPdf(bytes, mime);
      const uploaded = await uploadMailArtwork(pdf, "application/pdf");
      const preparation = savePreparation(input, original, {
        mode: "upload",
        assetId: uploaded.asset_id,
        filename: String(body.filename ?? "Uploaded artwork").slice(0, 200),
      });
      return jsonResponse({ preparation }, 200, req);
    }
    if (
      ["generate", "save-letter", "address", "research-address", "preview", "skip"].includes(
        action ?? "",
      )
    ) {
      if (!input) throw new Error("Select a prospect’s mail step");
      const original = context(input, true);
      if (action === "skip") {
        skipDirectMailStep(input);
        return jsonResponse({ ok: true }, 200, req);
      }
      if (action === "address") {
        const address = requireMailAddress(body.address);
        invalidate(input);
        ledger.setMailAddress(`prospect:${input.prospectId}`, address);
        return jsonResponse({ address }, 200, req);
      }
      if (action === "research-address") {
        const prospect = ledger.getProspectById(input.prospectId);
        const result = await researchBusinessAddress({ ...prospect }, input.playName);
        if (result.address && !ledger.getMailAddress(`prospect:${input.prospectId}`))
          ledger.setMailAddress(`prospect:${input.prospectId}`, result.address, result.source);
        return jsonResponse(
          { address: ledger.getMailAddress(`prospect:${input.prospectId}`) },
          200,
          req,
        );
      }
      if (action === "generate" || action === "save-letter") {
        const text =
          action === "generate"
            ? await generateMailLetter(input.prospectId, input.playName)
            : body.body;
        if (typeof text !== "string" || !text.trim() || text.length > 12000)
          throw new Error("Letter must contain 1–12,000 characters");
        await renderMailLetter(text);
        const preparation = savePreparation(input, original, { mode: "generated", body: text });
        return jsonResponse({ preparation }, 200, req);
      }
      // Addresses come from persisted prospect/setup data, never an empty standalone form.
      const to = requireMailAddress(ledger.getMailAddress(`prospect:${input.prospectId}`));
      const from = requireMailAddress(ledger.getMailAddress("return"));
      let prep = original.preparation;
      if (!prep) {
        prep = savePreparation(input, original, {
          mode: "generated",
          body: await generateMailLetter(input.prospectId, input.playName),
        });
      }
      const file =
        prep.mode === "upload"
          ? prep.assetId
          : (await uploadMailArtwork(await renderMailLetter(prep.body ?? ""), "application/pdf"))
              .asset_id;
      if (!file) throw new Error("Upload a PDF/JPEG or generate a letter first");
      savePreparation(input, original, prep);
      const draft = await previewDirectMail(input.prospectId, input.playName, {
        to,
        from,
        artwork: { kind: "letter", file, color: prep.mode === "upload", double_sided: false },
      });
      return jsonResponse({ draft }, 200, req);
    }
    if (!existing) throw new Error("Mailpiece not found");
    if (action === "refresh") return jsonResponse(await refreshDirectMail(existing.id), 200, req);
    if (action === "cancel") return jsonResponse(await cancelDirectMail(existing.id), 200, req);
    if (action === "approve")
      return jsonResponse(await approveDirectMail(existing.id, body.approval), 200, req);
    if (action === "send" || action === "approve-send") {
      const target = { prospectId: existing.prospectId, playName: existing.playName };
      if (
        !ledger.claimCadenceSendingMarker({
          ...target,
          startedAtIso: new Date().toISOString(),
          staleCutoffIso: new Date(Date.now() - 5 * 60000).toISOString(),
        })
      )
        throw new Error("This prospect already has a send in progress");
      try {
        if (action === "approve-send" && !existing.started)
          await approveDirectMail(existing.id, body.approval);
        return jsonResponse(await sendDirectMailCadenceStep(existing.id), 200, req);
      } finally {
        ledger.clearCadenceSendingMarker(target);
      }
    }
    return jsonResponse({ error: "Unknown direct-mail action" }, 404, req);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Direct mail failed" }, 400, req);
  } finally {
    if (lock) busy.delete(lock);
  }
}
