import { linkedinTemplatesOf, linkedinWriterOf, type OneShotConfig } from "@oneshot-gtm/core";
import {
  chooseLinkedInTemplate,
  type ChosenLinkedInTemplate,
  type LinkedInTemplateFacts,
  type LinkedInTemplateKind,
} from "@oneshot-gtm/shared-types";
import { firstNameFrom } from "./_lib.ts";
import { evidenceWithSubject } from "./_linkedin-evidence.ts";

/**
 * LinkedIn copy from the workspace's templates (the shipped defaults for any
 * step it leaves unset), or null when the workspace has the model write it
 * (`linkedin.writer: "model"`). No model call: the same facts give the same
 * text.
 */
export function templatedLinkedIn(
  kind: LinkedInTemplateKind,
  cfg: Pick<OneShotConfig, "linkedin">,
  facts: {
    name: string | null | undefined;
    /** An `agedEvidence` clause; given its subject here. */
    evidence?: string | null | undefined;
    offer?: string | null | undefined;
    alreadyConnected?: boolean;
  },
): ChosenLinkedInTemplate | null {
  if (linkedinWriterOf(cfg) === "model") return null;
  const values: LinkedInTemplateFacts = {
    first_name: firstNameFrom(facts.name),
    evidence: evidenceWithSubject(facts.evidence),
    offer: facts.offer ?? null,
    ...(facts.alreadyConnected ? { alreadyConnected: true } : {}),
  };
  return chooseLinkedInTemplate(kind, linkedinTemplatesOf(cfg), values);
}
