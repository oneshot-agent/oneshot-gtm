import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AddProspectResult } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input } from "../primitives/Field.tsx";
import { readOnly } from "../../lib/readOnly.ts";

/**
 * Add one prospect by profile URL.
 *
 * Shared by the /add-prospect route and the Queue's own "Add prospect" modal.
 * The Queue is where the result lands, so that is where the action belongs;
 * the route stays for bookmarks and for the link in the Queue's empty state.
 *
 * `onQueued` is what distinguishes the two. In the modal it closes the dialog,
 * so the confirmation panel below would never be seen and is skipped — the
 * toast and the new row are the confirmation. On the standalone page there is
 * nowhere to go, so the panel renders and points at the Queue.
 */
export function AddProspectForm({ onQueued }: { onQueued?: () => void }) {
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [last, setLast] = useState<{ kind: "queued" | "duplicate" } | null>(null);
  const queryClient = useQueryClient();

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
      // Research is asynchronous, so the row is not here yet; refetch anyway so
      // a queue open behind the modal is not left showing a stale count.
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
      onQueued?.();
    },
    onError: (err) => toast.error(`couldn't add: ${err.message}`),
  });

  const canSubmit = url.trim() !== "" && !add.isPending;

  return (
    <>
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
          <Button type="submit" variant="primary" size="md" disabled={!canSubmit} {...readOnly}>
            <UserPlus size={14} />
            {add.isPending ? "Adding…" : "Research & draft"}
          </Button>
          <span className="text-[12px] text-ink-faint">research takes ~2–5 min</span>
        </div>
      </form>

      {last && !onQueued && (
        <div className="mt-6 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-surface/40 px-4 py-3">
          <div className="text-[13px] text-ink-cream-2">
            {last.kind === "queued" ? (
              <>
                On it — researching the profile now. The drafted prospect will show up in the Queue
                when ready.
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
    </>
  );
}
