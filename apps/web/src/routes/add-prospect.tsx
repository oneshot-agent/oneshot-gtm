import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AddProspectResult } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Field, Input } from "../components/primitives/Field.tsx";

export const Route = createFileRoute("/add-prospect")({
  component: AddProspectPage,
});

function AddProspectPage() {
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [last, setLast] = useState<{ kind: "queued" | "duplicate" } | null>(null);

  const add = useMutation({
    mutationFn: (): Promise<AddProspectResult> =>
      api.addProspect(url.trim(), email.trim() || undefined),
    onSuccess: (res) => {
      if (res.duplicate) {
        setLast({ kind: "duplicate" });
        toast.info("already in the queue — this profile was added before");
        return;
      }
      setLast({ kind: "queued" });
      setUrl("");
      setEmail("");
      toast.success("researching profile — it'll appear in the Queue with a draft shortly");
    },
    onError: (err) => toast.error(`couldn't add: ${err.message}`),
  });

  const canSubmit = url.trim() !== "" && !add.isPending;

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Add Prospect</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 0.98,
            }}
          >
            One profile, one draft.
          </h1>
        </div>
      </section>

      <section className="px-6 py-6">
        <div className="max-w-xl">
          <p className="mb-5 text-[13.5px] leading-relaxed text-ink-cream-2">
            Paste a LinkedIn or X/Twitter profile. We research the person, pick the angle against
            your ICP, draft a tailored intro, and queue a 4-touch cadence — ready for your review in
            the{" "}
            <Link to="/queue" className="text-ink-cream underline underline-offset-2">
              Queue
            </Link>
            .
          </p>

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) add.mutate();
            }}
          >
            <Field
              label="Profile URL"
              hint="LinkedIn, X/Twitter, or GitHub. e.g. https://www.linkedin.com/in/jane-doe"
            >
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://x.com/janedoe"
                autoFocus
                required
              />
            </Field>

            <Field
              label="Email (optional)"
              hint="Only needed if research can't find one — sending is held until an email exists."
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@acme.com"
              />
            </Field>

            <div className="flex items-center gap-3 pt-1">
              <Button type="submit" variant="primary" size="md" disabled={!canSubmit}>
                <UserPlus size={14} />
                {add.isPending ? "Adding…" : "Research & draft"}
              </Button>
              <span className="text-[12px] text-ink-faint">research takes ~2–5 min</span>
            </div>
          </form>

          {last && (
            <div className="mt-6 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-surface/40 px-4 py-3">
              <div className="text-[13px] text-ink-cream-2">
                {last.kind === "queued" ? (
                  <>
                    On it — researching the profile now. The drafted prospect will show up in the
                    Queue when ready.
                  </>
                ) : (
                  <>This profile is already in the queue.</>
                )}
              </div>
              <Link
                to="/queue"
                className="mt-2 inline-flex items-center gap-1 text-[12px] text-ink-cream underline-offset-2 hover:underline"
              >
                Go to Queue <ArrowRight size={12} />
              </Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
