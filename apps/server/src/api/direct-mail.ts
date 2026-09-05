import {
  getLedger,
  uploadMailArtwork,
  previewDirectMail,
  refreshDirectMail,
  approveDirectMail,
  cancelDirectMail,
} from "@oneshot-gtm/core";
import { sendDirectMailCadenceStep, getSequence } from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";
export async function directMailRoute(req: Request): Promise<Response> {
  try {
    if (req.method === "GET")
      return jsonResponse(
        {
          drafts: getLedger().listDirectMail(),
          returnAddress: getLedger().getMailAddress("return"),
        },
        200,
        req,
      );
    const url = new URL(req.url);
    const action = url.pathname.split("/").pop();
    if (action === "upload") {
      const mime = req.headers.get("content-type") as
        | "application/pdf"
        | "image/png"
        | "image/jpeg";
      if (!["application/pdf", "image/png", "image/jpeg"].includes(mime))
        return jsonResponse({ error: "Unsupported artwork format" }, 400, req);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024)
        return jsonResponse({ error: "Artwork exceeds 20 MB" }, 400, req);
      return jsonResponse(await uploadMailArtwork(bytes, mime), 200, req);
    }
    const body = (await req.json()) as any;
    if (action === "preview") {
      const cadence = getLedger().getCadence(body.prospectId, body.playName);
      if (!cadence || !getSequence(body.playName)?.steps[cadence.current_step])
        throw new Error("No next cadence step");
      return jsonResponse(
        await previewDirectMail(body.prospectId, body.playName, body.input),
        200,
        req,
      );
    }
    if (typeof body.id !== "string") throw new Error("Mailpiece ID required");
    if (action === "refresh") return jsonResponse(await refreshDirectMail(body.id), 200, req);
    if (action === "approve")
      return jsonResponse(await approveDirectMail(body.id, body.approval), 200, req);
    if (action === "cancel") return jsonResponse(await cancelDirectMail(body.id), 200, req);
    if (action === "send") {
      const draft = getLedger().getDirectMail(body.id);
      if (!draft) throw new Error("Mailpiece not found");
      return jsonResponse(await sendDirectMailCadenceStep(body.id), 200, req);
    }
    return jsonResponse({ error: "Unknown direct-mail action" }, 404, req);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Direct mail failed" }, 400, req);
  }
}
