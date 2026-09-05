import { createFileRoute, Link } from "@tanstack/react-router";
import { AddProspectForm } from "../components/queue/AddProspectForm.tsx";

/**
 * The standalone page.
 *
 * Not in the sidebar any more — adding one prospect by hand is an occasional
 * act, and the Queue carries the action now, next to the rows it produces.
 * The route stays for bookmarks, for ⌘K, and for the Queue's empty state.
 */
export const Route = createFileRoute("/add-prospect")({
  component: AddProspectPage,
});

function AddProspectPage() {
  return (
    <div className="-mx-6 -my-6 flex flex-col">
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

          <AddProspectForm />
        </div>
      </section>
    </div>
  );
}
