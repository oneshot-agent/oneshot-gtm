import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, Mail, MessageSquare, Phone, Play } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Button } from "../components/primitives/Button.tsx";

export const Route = createFileRoute("/plays")({
  component: PlaysPage,
});

const CHANNEL_ICON = {
  email: Mail,
  sms: MessageSquare,
  voice: Phone,
  linkedin: MessageSquare,
} as const;

function PlaysPage() {
  const plays = useQuery({ queryKey: ["plays"], queryFn: api.plays });
  const [copiedName, setCopiedName] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Plays</h1>
        <span className="text-xs text-zinc-500">
          Read-only here. Run via CLI; the dashboard's run-form ships in R2.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {plays.data?.plays.map((p) => (
          <Card key={p.name}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="font-mono text-zinc-100">{p.name}</span>
                <div className="flex items-center gap-1">
                  {p.channels.map((ch) => {
                    const Icon = CHANNEL_ICON[ch] ?? Mail;
                    return (
                      <Badge tone="purple" key={ch} title={ch}>
                        <Icon size={10} />
                      </Badge>
                    );
                  })}
                </div>
              </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span>
                  {p.followupCount} follow-up{p.followupCount === 1 ? "" : "s"}
                </span>
                {p.hasBreakup && <Badge tone="yellow">breakup step</Badge>}
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <code className="block overflow-x-auto whitespace-nowrap font-mono text-xs text-zinc-200">
                  {p.cliInvocation}
                </code>
              </div>
              <div className="flex items-center gap-2">
                {(p.name === "show-hn" ||
                  p.name === "job-change" ||
                  p.name === "accelerator-batch") && (
                  <Link to="/run/$playName" params={{ playName: p.name }}>
                    <Button variant="primary" size="sm">
                      <Play size={12} /> run
                    </Button>
                  </Link>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(p.cliInvocation);
                    setCopiedName(p.name);
                    setTimeout(() => setCopiedName((n) => (n === p.name ? null : n)), 1500);
                  }}
                >
                  {copiedName === p.name ? (
                    <>
                      <Check size={12} /> copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} /> copy CLI
                    </>
                  )}
                </Button>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
