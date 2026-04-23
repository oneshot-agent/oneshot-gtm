import type {
  CadenceView,
  DoctorCheck,
  DrainRequest,
  DrainResult,
  EventsByPlay,
  HomeMetrics,
  OutcomeByPlay,
  OutcomeRequest,
  PlayDescriptor,
  QueueCounts,
  QueueRowView,
  QueueStatusView,
  ReceiptDetail,
  ReceiptView,
  RunTriggerResult,
  SetupRequest,
  SpendByPlay,
  TriggerView,
} from "@oneshot-gtm/shared-types";

const BASE = "/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  home: () => getJson<HomeMetrics>("/home"),
  cadences: (all = false) =>
    getJson<{ cadences: CadenceView[] }>(`/cadences${all ? "?all=1" : ""}`),
  cadenceForProspect: (id: number) => getJson<{ cadences: CadenceView[] }>(`/cadences/${id}`),
  stopCadence: (id: number, playName?: string) =>
    postJson<{ stopped: number }>(
      `/cadences/${id}/stop${playName ? `?play=${encodeURIComponent(playName)}` : ""}`,
      {},
    ),
  receipts: (opts?: { play?: string; sinceDays?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.play) q.set("play", opts.play);
    if (opts?.sinceDays != null) q.set("sinceDays", String(opts.sinceDays));
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return getJson<{ receipts: ReceiptView[] }>(`/receipts${qs ? `?${qs}` : ""}`);
  },
  receipt: (id: number) => getJson<{ receipt: ReceiptDetail }>(`/receipts/${id}`),
  plays: () => getJson<{ plays: PlayDescriptor[] }>("/plays"),
  measureCac: (sinceDays?: number) =>
    getJson<{ spend: SpendByPlay[]; events: EventsByPlay[] }>(
      `/measure/cac${sinceDays != null ? `?sinceDays=${sinceDays}` : ""}`,
    ),
  measureRocs: (sinceDays?: number) =>
    getJson<{ spend: SpendByPlay[]; events: EventsByPlay[]; outcomes: OutcomeByPlay[] }>(
      `/measure/rocs${sinceDays != null ? `?sinceDays=${sinceDays}` : ""}`,
    ),
  recordOutcome: (req: OutcomeRequest) => postJson<{ id: number }>("/measure/outcome", req),
  doctor: () => getJson<{ checks: DoctorCheck[] }>("/doctor"),
  setupStatus: () =>
    getJson<{
      cfg: {
        founderName: string | null;
        founderEmail: string | null;
        productOneLiner: string | null;
        icpOneLiner: string | null;
        llmProvider: "openrouter" | "openai" | "anthropic";
        llmModel: string;
        telemetryEnabled: boolean;
        walletMode: "cdp" | "private-key";
      };
      secretsPath: string;
      sources: Record<string, "env" | "file" | null>;
    }>("/setup"),
  setup: (req: SetupRequest) => postJson<{ ok: boolean }>("/setup", req),
  queue: (opts?: { play?: string; status?: QueueStatusView; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.play) q.set("play", opts.play);
    if (opts?.status) q.set("status", opts.status);
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return getJson<{ rows: QueueRowView[]; counts: QueueCounts }>(`/queue${qs ? `?${qs}` : ""}`);
  },
  approveQueue: (id: number) => postJson<{ ok: boolean }>(`/queue/${id}/approve`, {}),
  rejectQueue: (id: number, reason?: string) =>
    postJson<{ ok: boolean }>(`/queue/${id}/reject`, reason ? { reason } : {}),
  approveAllQueue: (play?: string) =>
    postJson<{ approved: number }>("/queue/approve-all", play ? { play } : {}),
  drainQueue: (req: DrainRequest) => postJson<DrainResult>("/queue/drain", req),
  triggers: () => getJson<{ triggers: TriggerView[] }>("/triggers"),
  setTriggerEnabled: (name: string, enabled: boolean) =>
    postJson<{ ok: boolean }>(`/triggers/${encodeURIComponent(name)}/enabled`, { enabled }),
  setTriggerConfig: (name: string, config: unknown) =>
    postJson<{ ok: boolean }>(`/triggers/${encodeURIComponent(name)}/config`, { config }),
  runTrigger: (name: string) =>
    postJson<RunTriggerResult>(`/triggers/${encodeURIComponent(name)}/run`, {}),
};
