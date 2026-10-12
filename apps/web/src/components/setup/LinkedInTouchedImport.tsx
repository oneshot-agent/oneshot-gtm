import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";

/**
 * "Already contacted on LinkedIn": upload a CSV or JSON of profiles another
 * tool already invited, so GTM never invites them. The same import as
 * `oneshot-gtm linkedin import-touched`; it sends nothing.
 */
export function LinkedInTouchedImport() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const count = useQuery({
    queryKey: ["linkedin-touched"],
    queryFn: () => api.linkedInTouched(),
    retry: false,
  });
  const upload = useMutation({
    mutationFn: async (file: File) => api.importLinkedInTouched(await file.text()),
    onSuccess: (r) => {
      setMessage(
        `imported ${r.imported} · already present ${r.present} · not a LinkedIn profile ${r.rejected}`,
      );
      void qc.invalidateQueries({ queryKey: ["linkedin-touched"] });
    },
    onError: (err) => setMessage(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="flex flex-col gap-1" data-testid="linkedin-touched-import">
      <p className="text-[12px] text-ink-muted">
        Already contacted on LinkedIn
        {count.data ? ` · ${count.data.count} profile${count.data.count === 1 ? "" : "s"}` : ""}.
        Import a CSV (profile_url, optional touched_at) or JSON of people another tool invited, so
        GTM does not invite them again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          className="text-[12px]"
          aria-label="Already contacted on LinkedIn file"
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setMessage(null);
            if (file) upload.mutate(file);
            if (input.current) input.current.value = "";
          }}
          {...readOnly}
        />
        {upload.isPending && <span className="text-[12px] text-ink-muted">Importing…</span>}
        {message && (
          <span role="status" className="text-[12px] text-ink-muted">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
