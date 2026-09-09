import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SenderIdentityView } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { Field, Select } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * Which Gmail identity's calendar the scheduler polls for past meetings
 * needing an outcome (issue #577). `calendarIdentityId: ""` (empty select
 * value) maps to `null` server-side — the feature entirely off, nothing
 * polls. Only `provider: 'gmail'` identities can be picked; a Gmail identity
 * with no calendar.readonly scope is shown but flagged so a founder doesn't
 * pick one that will just fail doctor.
 */
export function CalendarSection({
  cfg,
  onDirtyChange,
  identities,
}: SectionProps & { identities: SenderIdentityView[] }) {
  const gmailIdentities = identities.filter((i) => i.provider === "gmail");
  const server = useMemo(
    () => ({
      calendarIdentityId: cfg.calendarIdentityId ?? "",
      calendarId: cfg.calendarId ?? "primary",
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "calendar",
    server,
    toRequest: (sent) => ({
      ...(sent.calendarIdentityId !== undefined
        ? { calendarIdentityId: sent.calendarIdentityId.trim() || null }
        : {}),
      ...(sent.calendarId !== undefined ? { calendarId: sent.calendarId } : {}),
    }),
    onDirtyChange,
  });

  const calendars = useQuery({
    queryKey: ["setup", "calendars", s.values.calendarIdentityId],
    queryFn: () => api.setupCalendars(s.values.calendarIdentityId),
    enabled: Boolean(s.values.calendarIdentityId),
    staleTime: 60_000,
  });

  return (
    <SectionShell
      {...s.shell}
      lede="Reads past meetings from one Gmail calendar so they can be matched to prospects and prompted for an outcome. Read-only — nothing is written to the calendar."
    >
      {gmailIdentities.length === 0 ? (
        <span className="text-[12px] text-ink-faint">
          Connect a Gmail account in Email transport first.
        </span>
      ) : (
        <>
          <Field
            label="Calendar identity"
            hint="Off (no identity picked) means nothing polls and nothing is written."
          >
            <Select
              value={s.values.calendarIdentityId}
              onChange={(e) => s.set("calendarIdentityId", e.target.value)}
            >
              <option value="">Off</option>
              {gmailIdentities.map((i) => (
                <option key={i.id} value={i.id} disabled={i.hasCalendarScope === false}>
                  {i.address ?? i.id}
                  {i.hasCalendarScope === false ? " — needs calendar reconnect" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {s.values.calendarIdentityId && (
            <Field
              label="Calendar"
              hint="7-day event count helps tell which calendar your booking tool actually writes to."
            >
              <Select
                value={s.values.calendarId}
                onChange={(e) => s.set("calendarId", e.target.value)}
              >
                <option value="primary">primary</option>
                {(calendars.data?.calendars ?? [])
                  .filter((c) => c.id !== "primary")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.summary} ({c.recentEventCount} in last 7d)
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </SectionShell>
  );
}
