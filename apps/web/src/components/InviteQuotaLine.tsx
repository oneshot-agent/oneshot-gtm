import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";

/**
 * "LinkedIn invites today: 4 of 12 left · account 9 left". Where invites are
 * approved and sent (/queue, /cadences) and on the Setup LinkedIn card.
 * Renders nothing when no account is connected or nothing is known.
 */
export function InviteQuotaLine({ className }: { className?: string }) {
  const quota = useQuery({
    queryKey: ["linkedin-invites"],
    queryFn: () => api.linkedInInvites(),
    refetchInterval: 60_000,
    retry: false,
  });
  const text = quota.data?.connected ? quota.data.text : null;
  if (!text) return null;
  return (
    <span
      className={className ?? "font-mono text-[11px] text-ink-muted"}
      data-testid="invite-quota"
    >
      {text}
    </span>
  );
}
