import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Activity,
  BarChart3,
  Check,
  Copy,
  Eye,
  EyeOff,
  Feather,
  Inbox,
  Layers,
  Play,
  Receipt,
  Settings,
} from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { usePrivacy } from "../../lib/privacy.tsx";

type NavTarget = "/" | "/queue" | "/cadences" | "/receipts" | "/measure" | "/plays" | "/setup";

/**
 * ⌘K palette — bottom-docked. cmdk handles fuzzy search + keyboard nav;
 * we just supply the action groups. Closes on selection via the local
 * `run()` wrapper.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { masked, setMasked } = usePrivacy();
  const triggers = useQuery({
    queryKey: ["triggers"],
    queryFn: api.triggers,
    enabled: open,
    staleTime: 30_000,
  });
  const plays = useQuery({
    queryKey: ["plays"],
    queryFn: api.plays,
    enabled: open,
    staleTime: 60_000,
  });

  const runTrigger = useMutation({
    mutationFn: (name: string) => api.runTrigger(name),
    onSuccess: (data, name) => {
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
      if (data.error) toast.error(`${name} · ${data.error}`);
      else toast.success(`${name} · ran`);
    },
    onError: (err, name) => toast.error(`${name} · ${err.message}`),
  });

  const approveAll = useMutation({
    mutationFn: () => api.approveAllQueue(),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success(`approved ${data.approved} pending`);
    },
    onError: (err) => toast.error(err.message),
  });

  // Close on route change (cmdk's Dialog handles ESC + backdrop-click).
  useEffect(() => {
    if (!open) return;
    return () => {
      /* no-op: cmdk manages open state via onOpenChange */
    };
  }, [open]);

  const go = (to: NavTarget) => () => {
    navigate({ to });
    onOpenChange(false);
  };
  const act = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      className="fixed left-1/2 top-auto bottom-[min(14vh,88px)] z-[70] w-[min(640px,92vw)] -translate-x-1/2 [animation:ln-palette-in_240ms_var(--ease-reveal)]"
    >
      <Command.Input placeholder="Search for an action, a trigger, a play…" />

      <Command.List>
        <Command.Empty>no matches — try the sidebar.</Command.Empty>

        <Command.Group heading="Go">
          <Command.Item value="today home dashboard" onSelect={go("/")}>
            <Activity size={14} /> Today <kbd className="ml-auto">g h</kbd>
          </Command.Item>
          <Command.Item value="queue review" onSelect={go("/queue")}>
            <Inbox size={14} /> Queue <kbd className="ml-auto">g q</kbd>
          </Command.Item>
          <Command.Item value="cadences sequences" onSelect={go("/cadences")}>
            <Layers size={14} /> Cadences <kbd className="ml-auto">g c</kbd>
          </Command.Item>
          <Command.Item value="receipts signed" onSelect={go("/receipts")}>
            <Receipt size={14} /> Receipts <kbd className="ml-auto">g r</kbd>
          </Command.Item>
          <Command.Item value="measure cac rocs" onSelect={go("/measure")}>
            <BarChart3 size={14} /> Measure <kbd className="ml-auto">g m</kbd>
          </Command.Item>
          <Command.Item value="plays catalogue motion" onSelect={go("/plays")}>
            <Feather size={14} /> Plays <kbd className="ml-auto">g p</kbd>
          </Command.Item>
          <Command.Item value="setup config founder profile" onSelect={go("/setup")}>
            <Settings size={14} /> Setup <kbd className="ml-auto">g s</kbd>
          </Command.Item>
        </Command.Group>

        <Command.Group heading="Queue">
          <Command.Item
            value="approve all pending candidates"
            onSelect={act(() => approveAll.mutate())}
            disabled={approveAll.isPending}
          >
            <Check size={14} /> Approve all pending
          </Command.Item>
        </Command.Group>

        <Command.Group heading="View">
          <Command.Item
            value="privacy mode mask pii screenshot redact contacts"
            onSelect={act(() => setMasked(!masked))}
          >
            {masked ? <EyeOff size={14} /> : <Eye size={14} />}{" "}
            {masked ? "Disable privacy mode" : "Privacy mode — mask PII for screenshots"}
          </Command.Item>
        </Command.Group>

        {triggers.data && triggers.data.triggers.length > 0 && (
          <Command.Group heading="Run a trigger now">
            {triggers.data.triggers.map((t) => (
              <Command.Item
                key={t.name}
                value={`run trigger ${t.name}`}
                onSelect={act(() => runTrigger.mutate(t.name))}
                disabled={runTrigger.isPending}
              >
                <Play size={14} /> Run <code>{t.name}</code>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">
                  {t.enabled ? "· enabled" : "· disabled"}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {plays.data && plays.data.plays.length > 0 && (
          <Command.Group heading="Copy play CLI">
            {plays.data.plays.map((p) => (
              <Command.Item
                key={p.name}
                value={`copy cli ${p.name}`}
                onSelect={act(() => {
                  void navigator.clipboard.writeText(p.cliInvocation);
                  toast.success(`copied · ${p.name}`);
                })}
              >
                <Copy size={14} /> Copy <code>{p.name}</code> CLI
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
