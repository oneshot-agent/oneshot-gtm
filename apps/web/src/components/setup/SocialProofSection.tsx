import { useMemo } from "react";
import { Checkbox, Field, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function SocialProofSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      founderCredentials: cfg.founderCredentials ?? "",
      productPortfolio: cfg.productPortfolio ?? "",
      partners: cfg.partners ?? "",
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
      lede="All optional. Each maps to a different play type. Used by the LLM when drafting the second sentence of a first-touch email — never more than one beat per email."
    >
      <div className="grid grid-cols-1 gap-4">
        <Field
          label="Founder background"
          hint="Prior companies, named past roles, anything that lets a stranger trust you. Used by job-change / podcast-guest / post-funding / breakup-revive."
        >
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
          hint="Used in peer-founder outreach to show you've actually built things. Stack-consolidation / competitor-switch / show-hn / hiring-signal."
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
          hint="Brand names that open doors. Helps when the prospect doesn't know you yet. Accelerator-batch / demo-no-show."
        >
          <Textarea
            value={s.values.partners}
            onChange={(e) => s.set("partners", e.target.value)}
            placeholder="Comma-separated brand-name integrations or customers."
            rows={2}
          />
        </Field>
        <Field
          label="One true concession"
          hint="The thing you'd rather not say but is true. Used in roughly 1 in 3 first touches as a damaging admission (two of us, no logos yet, but…), which makes the rest of the email more believable. Leave blank and the beat is skipped, never invented."
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
