import { useQuery } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, Link } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Feather,
  Inbox,
  Layers,
  Mail,
  Receipt,
  Settings,
  UserPlus,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { Toaster } from "sonner";
import { api } from "../api/client.ts";
import { CommandPalette } from "../components/shell/CommandPalette.tsx";
import { PrivacyToggle } from "../components/shell/PrivacyToggle.tsx";
import { StatusBar } from "../components/shell/StatusBar.tsx";
import { StrategistDock } from "../components/shell/StrategistDock.tsx";
import { useKeyboard } from "../components/shell/useKeyboard.ts";
import { cn } from "../lib/cn.ts";
import { PrivacyProvider } from "../lib/privacy.tsx";

interface RootContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RootContext>()({
  component: RootLayout,
});

interface NavItem {
  to:
    | "/"
    | "/add-prospect"
    | "/queue"
    | "/inbox"
    | "/cadences"
    | "/receipts"
    | "/measure"
    | "/plays"
    | "/setup";
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Which alert-data key, if any, lights a dot next to this nav item. */
  alert?: "queue-pending" | "doctor-fail";
}

const NAV: NavItem[] = [
  { to: "/", label: "Today", icon: Activity },
  { to: "/add-prospect", label: "Add Prospect", icon: UserPlus },
  { to: "/queue", label: "Queue", icon: Inbox, alert: "queue-pending" },
  { to: "/inbox", label: "Replies", icon: Mail },
  { to: "/cadences", label: "Cadences", icon: Layers },
  { to: "/receipts", label: "Receipts", icon: Receipt },
  { to: "/measure", label: "Measure", icon: BarChart3 },
  { to: "/plays", label: "Plays", icon: Feather },
  { to: "/setup", label: "Setup", icon: Settings, alert: "doctor-fail" },
];

function RootLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeyboard({
    paletteOpen,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
  });

  // Alert signals — cheap queries, polled at a slower cadence than the
  // primary route data. These let the nav show a red dot without asking
  // the user to open the route.
  const queueQuery = useQuery({
    queryKey: ["queue", "pending", "all"],
    queryFn: () => api.queue({ status: "pending", limit: 1 }),
    refetchInterval: 60_000,
  });
  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: api.doctor,
    refetchInterval: 60_000,
  });

  const alerts: Record<NonNullable<NavItem["alert"]>, boolean> = {
    "queue-pending": (queueQuery.data?.counts.pending ?? 0) > 0,
    "doctor-fail": (doctor.data?.checks ?? []).some((c) => c.severity === "fail"),
  };

  return (
    <PrivacyProvider>
      <div className="grid h-full grid-cols-[224px_1fr] grid-rows-[auto_1fr_auto] bg-ink-bg text-ink-cream">
        <aside className="row-span-3 flex flex-col border-r border-ink-rule bg-ink-bg/60 px-3 py-5 backdrop-blur-[2px]">
          <div className="mb-7 px-2">
            <div
              className="text-ink-cream"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 19,
                letterSpacing: "-0.01em",
                lineHeight: 1.1,
              }}
            >
              oneshot
              <span className="text-[color:var(--ink-spend-2)]">·</span>gtm
            </div>
            <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
              Founder's ledger
            </div>
          </div>

          <nav className="flex flex-col gap-0.5" aria-label="primary">
            {NAV.map(({ to, label, icon: Icon, alert }) => {
              const hasAlert = alert ? alerts[alert] : false;
              return (
                <Link
                  key={to}
                  to={to}
                  activeOptions={{ exact: to === "/" }}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5",
                    "font-sans text-[13px] text-ink-cream-2",
                    "transition-colors duration-[var(--dur-stamp)]",
                    "hover:bg-ink-surface hover:text-ink-cream",
                  )}
                  activeProps={{
                    className: "bg-ink-surface text-ink-cream",
                    "data-active": "true",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute bottom-1 left-0 top-1 w-[2px] rounded-full",
                      "bg-[color:var(--ink-signal)]",
                      "opacity-0 transition-opacity duration-[var(--dur-stamp)]",
                      "group-data-[active=true]:opacity-100",
                    )}
                  />
                  <Icon
                    size={14}
                    className={cn(
                      "text-ink-muted transition-colors",
                      "group-hover:text-ink-cream-2",
                      "group-data-[active=true]:text-[color:var(--ink-signal-2)]",
                    )}
                  />
                  <span className="flex-1">{label}</span>
                  {hasAlert && (
                    <span
                      aria-label={alertLabel(alert)}
                      title={alertLabel(alert)}
                      className={cn(
                        "h-[6px] w-[6px] shrink-0 rounded-full",
                        alert === "doctor-fail"
                          ? "bg-[color:var(--ink-blocked)]"
                          : "bg-[color:var(--ink-spend)]",
                        "shadow-[0_0_0_2px_color-mix(in_oklch,currentColor_0%,var(--ink-bg)_100%)]",
                      )}
                    />
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-ink-rule pt-4 px-2">
            <div className="ln-eyebrow mb-2" style={{ fontSize: 10 }}>
              Keys
            </div>
            <div className="space-y-1 font-mono text-[11px] text-ink-faint">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="group flex w-full items-center justify-between rounded-[var(--radius-xs)] px-1 py-0.5 text-left transition-colors hover:bg-ink-surface/80"
                aria-label="open command palette"
              >
                <span className="group-hover:text-ink-cream-2">palette</span>
                <kbd className="rounded border border-ink-rule px-1 text-ink-cream-2">⌘K</kbd>
              </button>
              <div className="flex justify-between px-1">
                <span>queue</span>
                <kbd className="rounded border border-ink-rule px-1 text-ink-cream-2">g q</kbd>
              </div>
              <div className="flex justify-between px-1">
                <span>home</span>
                <kbd className="rounded border border-ink-rule px-1 text-ink-cream-2">g h</kbd>
              </div>
            </div>
          </div>
        </aside>

        <header className="flex items-center justify-between border-b border-ink-rule bg-ink-bg/70 px-6 py-2.5 backdrop-blur-[2px]">
          <div className="text-[11.5px] text-ink-faint ln-mono">
            single user · local-first · bound to <span className="text-ink-muted">127.0.0.1</span>
          </div>
          <div className="flex items-center gap-3">
            <PrivacyToggle />
            <StatusBar />
          </div>
        </header>

        <main className="overflow-y-auto px-6 py-6">
          <Outlet />
        </main>

        <footer className="border-t border-ink-rule bg-ink-bg/70 px-6 py-2 text-[11px] text-ink-faint backdrop-blur-[2px]">
          Built on OneShot · Read every prompt · Fork every play ·{" "}
          <span className="text-ink-muted">MIT</span>
        </footer>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <StrategistDock />

        <Toaster
          position="bottom-right"
          theme="dark"
          richColors={false}
          toastOptions={{
            className: [
              "!bg-[color:var(--ink-surface)]",
              "!text-[color:var(--ink-cream)]",
              "!border-[color:var(--ink-rule)]",
              "!font-sans",
              "!shadow-[var(--shadow-ink-bleed)]",
            ].join(" "),
            style: {
              borderRadius: "var(--radius-md)",
            },
          }}
        />
      </div>
    </PrivacyProvider>
  );
}

function alertLabel(alert: NavItem["alert"]): string {
  if (alert === "queue-pending") return "pending candidates waiting for review";
  if (alert === "doctor-fail") return "doctor has a failing check";
  return "";
}
