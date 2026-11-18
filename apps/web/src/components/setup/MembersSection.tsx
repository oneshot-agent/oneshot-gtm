import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CurrentMember } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useReportDirty, type DirtyReporter } from "./types.ts";

type Change =
  | { action: "add" | "remove"; email: string }
  | { action: "role"; email: string; role: CurrentMember["role"] };

export function MembersSection({ onDirtyChange }: { onDirtyChange: DirtyReporter }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["members"], queryFn: api.members });
  const [email, setEmail] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const owner = query.data?.currentMember.role === "owner";
  const dirty = owner && email.length > 0;
  useReportDirty("members", dirty, onDirtyChange);
  const mutation = useMutation({
    mutationFn: (change: Change) => {
      if (change.action === "add") return api.addMember(change.email);
      if (change.action === "remove") return api.removeMember(change.email);
      return api.setMemberRole(change.email, change.role);
    },
    onSuccess: async (_, change) => {
      if (change.action === "add") setEmail("");
      setSavedAt(Date.now());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["members"] }),
        qc.invalidateQueries({ queryKey: ["me"] }),
      ]);
    },
  });
  const owners = query.data?.members.filter((m) => m.role === "owner").length ?? 0;
  const error = mutation.error ?? query.error;

  return (
    <SectionShell
      id="members"
      lede="Members share every workspace on this install. Only owners can add, remove or change roles."
      dirtyCount={dirty ? 1 : 0}
      savedAt={savedAt}
      saving={mutation.isPending}
      saveDisabled={!owner || !email.trim() || query.isError}
      saveLabel="Add member"
      onSubmit={() => {
        if (owner && email.trim() && !query.isError) {
          mutation.mutate({ action: "add", email: email.trim() });
        }
      }}
      footerNote="Changes apply to the next request on every workspace."
    >
      {query.isPending && <p role="status">Loading members…</p>}
      {error && <p role="alert">{error.message}</p>}
      {query.isError && (
        <Button type="button" onClick={() => void query.refetch()}>
          Retry
        </Button>
      )}
      {query.data && (
        <>
          {query.data.members.length === 0 ? (
            <p>No members yet. This machine has local owner access.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Email</th>
                    <th className="p-2">Name</th>
                    <th className="p-2">Role</th>
                    <th className="p-2">Added</th>
                    {owner && <th className="p-2">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {query.data.members.map((m) => {
                    const lastOwner = m.role === "owner" && owners === 1;
                    const disabled = mutation.isPending || query.isError || lastOwner;
                    return (
                      <tr key={m.email} className="border-t border-ink-rule">
                        <td className="p-2">{m.email}</td>
                        <td className="p-2">{m.name ?? "—"}</td>
                        <td className="p-2">
                          {owner ? (
                            <Select
                              aria-label={`Role for ${m.email}`}
                              value={m.role}
                              disabled={disabled}
                              title={
                                lastOwner
                                  ? "Add another owner before demoting this owner."
                                  : undefined
                              }
                              onChange={(e) =>
                                mutation.mutate({
                                  action: "role",
                                  email: m.email,
                                  role: e.target.value as CurrentMember["role"],
                                })
                              }
                              {...readOnly}
                            >
                              <option value="member">member</option>
                              <option value="owner">owner</option>
                            </Select>
                          ) : (
                            m.role
                          )}
                        </td>
                        <td className="whitespace-nowrap p-2">
                          <time dateTime={m.addedAt}>
                            {new Date(m.addedAt).toLocaleDateString()}
                          </time>
                        </td>
                        {owner && (
                          <td className="p-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              disabled={disabled}
                              aria-label={`Remove ${m.email}`}
                              title={lastOwner ? "The last owner cannot be removed." : undefined}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Remove ${m.email}? Their next request will be refused.`,
                                  )
                                ) {
                                  mutation.mutate({ action: "remove", email: m.email });
                                }
                              }}
                              {...readOnly}
                            >
                              Remove
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-sm">
            Allowed hosts:{" "}
            {query.data.allowedHosts.length
              ? query.data.allowedHosts.join(", ")
              : "none (loopback on this machine only)"}
          </p>
          {owner ? (
            <Field
              label="Member email"
              hint="Their Tailscale login. Added as a member; change their role above."
            >
              <Input
                value={email}
                inputMode="email"
                autoComplete="email"
                placeholder="teammate@example.com"
                disabled={mutation.isPending || query.isError}
                onChange={(e) => setEmail(e.target.value)}
                {...readOnly}
              />
            </Field>
          ) : (
            <p className="text-sm">Only owners can manage members.</p>
          )}
          {owners === 1 && <p className="text-sm">The last owner cannot be removed or demoted.</p>}
        </>
      )}
    </SectionShell>
  );
}
