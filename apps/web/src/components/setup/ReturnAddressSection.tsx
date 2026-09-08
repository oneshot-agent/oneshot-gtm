import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PostalAddress } from "@oneshot-gtm/core";
import { MailAddressForm, blankMailAddress } from "../MailAddressForm.tsx";
import { mailAction } from "../DirectMailPanel.tsx";
import { Button } from "../primitives/Button.tsx";
import { readOnly } from "../../lib/readOnly.ts";
export function ReturnAddressSection({ founderName }: { founderName: string }) {
  const cache = useQueryClient();
  const { data } = useQuery<{ returnAddress: PostalAddress | null }>({
    queryKey: ["direct-mail", "return"],
    queryFn: async () => {
      const r = await fetch("/api/direct-mail");
      if (!r.ok) throw new Error("Could not load return address");
      return r.json();
    },
  });
  const [address, setAddress] = useState({ ...blankMailAddress, name: founderName });
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!dirty) setAddress(data?.returnAddress ?? { ...blankMailAddress, name: founderName });
  }, [data, founderName, dirty]);
  return (
    <details className="mt-5 border-t border-ink-rule pt-4">
      <summary className="cursor-pointer text-sm">
        Direct mail return address{data?.returnAddress ? " · saved" : " · set once"}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-ink-muted">
          Used automatically for prospects in motions that include mail.
        </p>
        <MailAddressForm
          label="Founder return address · U.S."
          value={address}
          onChange={(v) => {
            setAddress(v);
            setDirty(true);
          }}
          disabled={busy || readOnly.disabled}
        />
        {error && <p role="alert">{error}</p>}
        <Button
          type="button"
          size="sm"
          disabled={busy || !dirty || readOnly.disabled}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await mailAction("return-address", { address });
              await cache.invalidateQueries({ queryKey: ["direct-mail"] });
              setDirty(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save return address
        </Button>
      </div>
    </details>
  );
}
