import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { Field, Select } from "../primitives/Field.tsx";
import type { SetupCfg } from "./types.ts";

/** Account selection is a workspace preference, saved separately from credentials. */
export function LinkedInAccountPicker({ cfg }: { cfg: SetupCfg }) {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ["replies"],
    queryFn: api.replies,
    select: (r) => r.accounts,
  });
  const save = useMutation({
    mutationFn: (accountKey: string) => api.setup({ linkedin: { accountKey: accountKey || null } }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["setup"] }),
        qc.invalidateQueries({ queryKey: ["doctor"] }),
        qc.invalidateQueries({ queryKey: ["linkedin-invites"] }),
      ]);
    },
  });
  const key = cfg.linkedin?.accountKey ?? "";
  const connected = (accounts.data ?? []).filter((a) => a.status === "connected");
  const selected = accounts.data?.find((a) => a.key === key);
  const reason = key
    ? !selected
      ? "The selected account was removed or is missing."
      : selected.status !== "connected"
        ? "The selected account is disconnected."
        : null
    : connected.length > 1
      ? "Several accounts are connected; this workspace has not selected one."
      : null;
  return (
    <Field
      label="Send and read profiles as"
      hint={
        accounts.isSuccess && reason
          ? `${reason} LinkedIn sends and live profile reads are paused. Choose a connected account here, or reconnect the selected account.`
          : "This workspace uses this account for invites, LinkedIn messages and profile reads. Changes save immediately."
      }
      error={save.error?.message ?? accounts.error?.message}
    >
      <Select
        value={key}
        disabled={!accounts.isSuccess || save.isPending}
        onChange={(e) => save.mutate(e.target.value)}
      >
        <option value="">
          {connected.length === 1 ? `Automatic: ${connected[0]!.name}` : "Choose an account"}
        </option>
        {key && !connected.some((a) => a.key === key) && (
          <option value={key}>{selected?.name ?? key} (unavailable)</option>
        )}
        {connected.map((a) => (
          <option key={a.key} value={a.key}>
            {a.name} · {a.workspace}
          </option>
        ))}
      </Select>
    </Field>
  );
}
