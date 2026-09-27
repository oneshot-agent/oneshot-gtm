import { CHANNEL_SPECS, loadConfig, xHandleFrom } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { type LinkedInFirstTouchRow, signalLines } from "./_linkedin-first-touch.ts";
import { voiceBlock } from "./_lib.ts";

/**
 * First touch on the X channel: a DM drafted from the row's play signal.
 * OneShot has no X action API, so it is sent by hand and recorded with Mark
 * sent (channels.ts: x is `manual`). x-amplify-dm keeps its own amplifier
 * prompt; every other play's X rows are drafted here.
 */

/** The X handle a row's DM goes to: its `handle`, else its X profile URL. */
export function xHandleOf(payload: Record<string, unknown>): string | null {
  const handle = typeof payload["handle"] === "string" ? payload["handle"] : null;
  const url = typeof payload["twitterUrl"] === "string" ? payload["twitterUrl"] : null;
  return xHandleFrom(handle) ?? xHandleFrom(url);
}

export async function draftXDm(
  row: LinkedInFirstTouchRow,
  opts: { draftAngle?: string | null } = {},
): Promise<{ subject: string; body: string; flags: string[]; voiceKey: string | null }> {
  const cfg = loadConfig();
  const maxChars = CHANNEL_SPECS.x.firstTouchMaxChars ?? 280;
  const p = row.payload;
  const str = (k: string) =>
    typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string).trim() : null;
  const name = str("name") ?? "them";
  const handle = xHandleOf(p);
  const voice = voiceBlock("intro");
  const input = [
    `FOUNDER: ${cfg.founderName ?? ""}`,
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    "PERSON:",
    `  NAME: ${name}`,
    ...(handle ? [`  X: @${handle}`] : []),
    ...((str("title") ?? str("currentRole"))
      ? [`  ROLE: ${str("title") ?? str("currentRole")}`]
      : []),
    ...(str("company") ? [`  COMPANY: ${str("company")}`] : []),
    "SIGNAL:",
    ...signalLines(row).map((l) => `  ${l}`),
    ...(opts.draftAngle ? [`ANGLE: ${opts.draftAngle}`] : []),
    ...(voice ? [`VOICE:\n${voice.text}`] : []),
    `MAX_CHARS: ${maxChars}`,
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("x-dm") },
      { role: "user", content: input },
    ],
    temperature: 0.7,
    maxTokens: 600,
  });
  const body = res.content.trim().replace(/^"|"$/g, "");
  if (!body) throw new Error("empty DM from the model");
  const flags: string[] = [];
  if (body.length > maxChars) flags.push(`dm-too-long: ${body.length}/${maxChars} characters`);
  if (!handle) flags.push("no-x: this row has no X handle");
  return {
    subject: `X DM → ${handle ? `@${handle}` : name}`,
    body,
    flags,
    voiceKey: voice?.key ?? null,
  };
}
