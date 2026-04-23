import { Outlet, createRootRouteWithContext, Link } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Activity, BarChart3, Inbox, Layers, Receipt, Settings, Zap } from "lucide-react";
import { cn } from "../lib/cn.ts";

interface RootContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RootContext>()({
  component: RootLayout,
});

const NAV = [
  { to: "/", label: "Home", icon: Activity },
  { to: "/queue", label: "Queue", icon: Inbox },
  { to: "/cadences", label: "Cadences", icon: Layers },
  { to: "/receipts", label: "Receipts", icon: Receipt },
  { to: "/measure", label: "Measure", icon: BarChart3 },
  { to: "/plays", label: "Plays", icon: Zap },
  { to: "/setup", label: "Setup", icon: Settings },
] as const;

function RootLayout() {
  return (
    <div className="grid h-full grid-cols-[220px_1fr] grid-rows-[auto_1fr_auto] bg-zinc-950 text-zinc-200">
      <aside className="row-span-3 border-r border-zinc-800 bg-zinc-900/30 px-3 py-5">
        <div className="mb-6 px-2">
          <div className="text-sm font-semibold text-zinc-100">oneshot-gtm</div>
          <div className="text-xs text-zinc-500">local dashboard</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100",
              )}
              activeProps={{ className: "bg-zinc-800 text-zinc-100" }}
            >
              <Icon size={14} />
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      <header className="border-b border-zinc-800 bg-zinc-950/80 px-6 py-3 backdrop-blur">
        <div className="text-xs text-zinc-500">
          Single-user · local-first · binds to <code className="text-zinc-400">127.0.0.1</code>
        </div>
      </header>

      <main className="overflow-y-auto px-6 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-zinc-800 bg-zinc-950/80 px-6 py-2 text-xs text-zinc-500">
        Built on OneShot. Read every prompt. Fork every play.{" "}
        <span className="text-zinc-400">MIT.</span>
      </footer>
    </div>
  );
}
