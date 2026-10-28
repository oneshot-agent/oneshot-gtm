import { useMemo } from "react";
import { Field, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/** Past this the block builder cuts the card; the counter turns red first. */
const VOICE_CARD_MAX_CHARS = 1500;

const PLACEHOLDER = [
  "MOVES",
  "- (how you open, how you make a point, how you close)",
  "SENTENCES",
  "- (length and rhythm, case, the punctuation you use or avoid)",
  "NEVER",
  "- (words and habits you never want written in your name)",
  "EXEMPLARS",
  "- (a few short lines copied from your own writing)",
].join("\n");

/**
 * The founder's own register, as a short card the drafts read at runtime.
 * Blank means no VOICE block and drafts exactly as before. The card shapes
 * sentence texture only; the prompts' structure and the anti-slop rules
 * still win, and the block's own budget line says so to the model.
 */
export function VoiceSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => ({ founderVoice: cfg.founderVoice ?? "" }), [cfg]);
  const s = useConfigSection({
    id: "voice",
    server,
    toRequest: (sent) => sent,
    onDirtyChange,
  });
  const length = s.values.founderVoice.length;
  const over = length > VOICE_CARD_MAX_CHARS;

  return (
    <SectionShell
      {...s.shell}
      lede="How you write, in your words. The drafts keep their structure and the anti-slop rules; this shapes the sentences. One aphoristic line per email at most."
    >
      <Field
        label="Voice card"
        hint="Four short sections: MOVES, SENTENCES, NEVER, EXEMPLARS. Write it by hand, or draft it from your own posts with `oneshot-gtm config voice --from <dir>` and edit here. See docs/voice.md for a worked example."
      >
        <Textarea
          value={s.values.founderVoice}
          onChange={(e) => s.set("founderVoice", e.target.value)}
          placeholder={PLACEHOLDER}
          rows={12}
        />
      </Field>
      <div
        className={
          over
            ? "font-mono text-[11px] text-[color:var(--ink-blocked-2)]"
            : "font-mono text-[11px] text-ink-faint"
        }
      >
        {length} / {VOICE_CARD_MAX_CHARS} characters
        {over ? " · the drafts read only the first 1500" : ""}
        {length === 0 ? " · blank = no voice block, drafts unchanged" : ""}
      </div>
    </SectionShell>
  );
}
