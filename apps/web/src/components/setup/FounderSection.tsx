import { useMemo } from "react";
import { Field, Input, Textarea } from "../primitives/Field.tsx";
import { validateBareDomain, validateEmail } from "../../lib/setupValidation.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function FounderSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      founderName: cfg.founderName ?? "",
      founderEmail: cfg.founderEmail ?? "",
      productDomain: cfg.productDomain ?? "",
      sendingDomain: cfg.sendingDomain ?? "",
      productOneLiner: cfg.productOneLiner ?? "",
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "profile",
    server,
    toRequest: (sent) => sent,
    validate: (v) => ({
      founderEmail: validateEmail(v.founderEmail),
      productDomain: validateBareDomain(v.productDomain),
      sendingDomain: validateBareDomain(v.sendingDomain),
    }),
    onDirtyChange,
  });

  return (
    <SectionShell {...s.shell} lede="How prospects see you on the other side of the inbox.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <Input
            value={s.values.founderName}
            onChange={(e) => s.set("founderName", e.target.value)}
            placeholder="Jane Doe"
          />
        </Field>
        <Field
          label="Your email"
          error={s.errors.founderEmail}
          hint="For lead-capture pages this tool generates. Replies go to the sending identity, not here."
        >
          <Input
            type="email"
            value={s.values.founderEmail}
            onChange={(e) => s.set("founderEmail", e.target.value)}
            placeholder="jane@yourcompany.com"
          />
        </Field>
        <Field
          label="Signature domain"
          error={s.errors.productDomain}
          hint="Shown under your name in every signature. Blank = no domain line."
        >
          <Input
            value={s.values.productDomain}
            onChange={(e) => s.set("productDomain", e.target.value)}
            placeholder="yourcompany.com"
          />
        </Field>
        <Field
          label="Sending domain"
          error={s.errors.sendingDomain}
          hint="Wallet-owned domain mail goes out from, as <first-name>@domain. Blank = SDK default."
        >
          <Input
            value={s.values.sendingDomain}
            onChange={(e) => s.set("sendingDomain", e.target.value)}
            placeholder="yourcompany-mail.com"
          />
        </Field>
        <Field
          label="Product one-liner"
          hint="What you're building, in one sentence."
          className="md:col-span-2"
        >
          <Textarea
            value={s.values.productOneLiner}
            onChange={(e) => s.set("productOneLiner", e.target.value)}
            placeholder={
              'e.g. "Stripe for freight" · "AI bookkeeping for restaurants" · "scheduling for dog groomers"'
            }
            rows={2}
          />
        </Field>
      </div>
    </SectionShell>
  );
}
