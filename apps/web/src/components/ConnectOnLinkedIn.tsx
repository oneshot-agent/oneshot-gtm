import type { LinkedInFriendInviteState } from "@oneshot-gtm/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client.ts";
import { timeAgo } from "../lib/cn.ts";
import { readOnly } from "../lib/readOnly.ts";
import { Button } from "./primitives/Button.tsx";
import { Textarea } from "./primitives/Field.tsx";

const STATE_LABEL: Record<LinkedInFriendInviteState, string> = {
  sent: "sent, waiting for them to accept",
  accepted: "accepted",
  withdrawn: "withdrawn",
  already_connected: "already connected",
};

/**
 * Connect on LinkedIn (#791) for a person who replied positively to an email.
 * Shown only when the server says they qualify; otherwise it shows the state
 * of an invite already sent, or nothing. The note is drafted on request,
 * edited here, and sent only by the founder's click: nothing is automatic and
 * no message follows.
 */
export function ConnectOnLinkedIn({ prospectId }: { prospectId: number | null }) {
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [maxChars, setMaxChars] = useState(300);
  const view = useQuery({
    queryKey: ["linkedin-friend", prospectId],
    queryFn: () => api.linkedInFriend(prospectId as number),
    enabled: prospectId != null,
    retry: false,
    staleTime: 30_000,
  });
  const draft = useMutation({
    mutationFn: () => api.linkedInFriendDraft(prospectId as number),
    onSuccess: (d) => {
      setNote(d.note);
      setFlags(d.flags);
      setMaxChars(d.maxChars);
    },
    onError: (e: Error) => toast.error(`couldn't draft · ${e.message}`),
  });
  const send = useMutation({
    mutationFn: () => api.linkedInFriendSend(prospectId as number, note ?? ""),
    onSuccess: () => {
      setNote(null);
      setFlags([]);
      void qc.invalidateQueries({ queryKey: ["linkedin-friend", prospectId] });
      void qc.invalidateQueries({ queryKey: ["linkedin-invites"] });
      toast.success("connection request sent");
    },
    onError: (e: Error) => toast.error(`couldn't send · ${e.message}`),
  });

  const data = view.data;
  if (prospectId == null || !data) return null;
  if (data.invite) {
    return (
      <p className="replies-linkedin-invite" data-testid="friend-invite-state">
        <span>LinkedIn invite:</span> {STATE_LABEL[data.invite.state]} ·{" "}
        {timeAgo(data.invite.sentAt)}
      </p>
    );
  }
  if (!data.canConnect) return null;

  if (note === null) {
    return (
      <div className="mt-3">
        <Button
          size="sm"
          variant="ghost"
          disabled={draft.isPending}
          onClick={() => draft.mutate()}
          title="Draft a short note that mentions your emails. You review it before anything is sent."
          {...readOnly}
        >
          {draft.isPending ? "Drafting…" : "Connect on LinkedIn"}
        </Button>
      </div>
    );
  }
  const over = note.length > maxChars;
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="friend-preview">
      <label
        className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint"
        htmlFor={`friend-note-${prospectId}`}
      >
        connection note — preview and edit; nothing is sent until you press send
      </label>
      <Textarea
        id={`friend-note-${prospectId}`}
        value={note}
        rows={4}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        <span className={over ? "text-red-400" : undefined}>
          {note.length}/{maxChars}
        </span>
        {flags.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={send.isPending || over || !note.trim()}
          onClick={() => send.mutate()}
          {...readOnly}
        >
          {send.isPending ? "Sending…" : "Send connection request"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={send.isPending || draft.isPending}
          onClick={() => draft.mutate()}
        >
          Redraft
        </Button>
        <Button size="sm" variant="ghost" disabled={send.isPending} onClick={() => setNote(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
