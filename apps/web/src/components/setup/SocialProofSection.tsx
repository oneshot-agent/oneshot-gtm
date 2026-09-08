import { useMemo } from "react";
import { Checkbox, Field, Input, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function SocialProofSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      founderCredentials: cfg.founderCredentials ?? "",
      productPortfolio: cfg.productPortfolio ?? "",
      partners: cfg.partners ?? "",
      founderCohort: cfg.founderCohort ?? "",
      founderAdmission: cfg.founderAdmission ?? "",
      mobileSignature: cfg.mobileSignature,
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "proof",
    server,
    toRequest: (sent) => sent,
    onDirtyChange,
  });

  return (
    <SectionShell
      {...s.shell}
      lede="All optional. At most one of these lands in a first-touch email, as its second sentence."
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="Founder background" hint="Prior companies and roles a stranger would trust.">
          <Textarea
            value={s.values.founderCredentials}
            onChange={(e) => s.set("founderCredentials", e.target.value)}
            placeholder={
              'e.g. "ex-Stripe eng" · "VP Sales at Salesforce" · "ran a $2M Shopify store"'
            }
            rows={2}
          />
        </Field>
        <Field
          label="Products you've shipped"
          hint="Proof you've built things, for peer-founder outreach."
        >
          <Textarea
            value={s.values.productPortfolio}
            onChange={(e) => s.set("productPortfolio", e.target.value)}
            placeholder="Comma-separated list of products or projects you've shipped."
            rows={2}
          />
        </Field>
        <Field
          label="Notable partners / customers"
          hint="Brand names that open doors when the prospect doesn't know you."
        >
          <Textarea
            value={s.values.partners}
            onChange={(e) => s.set("partners", e.target.value)}
            placeholder="Comma-separated brand-name integrations or customers."
            rows={2}
          />
        </Field>
        <Field
          label="Your accelerator batch"
          hint="Only if you actually did one. Blank — the right answer for most founders — makes accelerator-batch outreach write as an outsider, which is what it is. Claiming a batch you weren't in is the fastest way to burn the email."
        >
          <Input
            value={s.values.founderCohort}
            onChange={(e) => s.set("founderCohort", e.target.value)}
            placeholder="e.g. yc-w23 · spc-2025-1 · (leave blank)"
          />
        </Field>
        <Field
          label="One true concession"
          hint="The true thing you'd rather not say. Used in about 1 in 3 first touches; it makes the rest believable. Blank = skipped, never invented."
        >
          <Textarea
            value={s.values.founderAdmission}
            onChange={(e) => s.set("founderAdmission", e.target.value)}
            placeholder="e.g. two people, no enterprise logos yet"
            rows={2}
          />
        </Field>
        <Checkbox
          checked={s.values.mobileSignature}
          onChange={(e) => s.set("mobileSignature", e.target.checked)}
          label={'Append "Sent from my iPhone" to every email signature'}
        />
      </div>
    </SectionShell>
  );
}
