import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import { Button } from "../primitives/Button.tsx";
import { openStrategist } from "../../lib/openStrategist.ts";

export function NextStep({ autoOpen = true }: { autoOpen?: boolean }) {
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["onboarding"], queryFn: api.onboarding, enabled: !IS_DEMO });
  useEffect(() => {
    if (autoOpen && status.data?.autoOpen) void navigate({ to: "/onboarding", replace: true });
  }, [autoOpen, status.data?.autoOpen, navigate]);
  if (IS_DEMO || status.data?.demo) return null;
  if (status.error)
    return (
      <p className="p-6">
        Could not check onboarding. <Link to="/onboarding">Open onboarding</Link>
      </p>
    );
  if (!status.data) return null;
  return (
    <section className="space-y-3 border-b border-ink-rule px-6 py-5">
      <h2 className="text-lg font-semibold text-ink-cream">
        {status.data.ready ? "Ready to plan" : "Get ready to plan your first motion"}
      </h2>
      {status.data.ready ? (
        <Button onClick={openStrategist}>Plan my first motion</Button>
      ) : (
        <>
          <p className="text-sm text-ink-muted">Still needed: {status.data.missing.join(", ")}.</p>
          <Link className="text-ink-cream underline" to="/onboarding">
            Resume onboarding
          </Link>
        </>
      )}
    </section>
  );
}
