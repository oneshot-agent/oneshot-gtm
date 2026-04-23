export interface ReceiptRecord {
  id: number;
  play_name: string;
  call_type: string;
  cost_usd: number | null;
  signed_receipt: string | null;
  oneshot_request_id: string | null;
  created_at: string;
}

export interface ProspectRecord {
  id: number;
  name: string | null;
  email: string | null;
  company: string | null;
  linkedin_url: string | null;
  dossier_json: string | null;
  source: string | null;
  created_at: string;
}

export interface SequenceEventRecord {
  id: number;
  prospect_id: number;
  play_name: string;
  step_index: number;
  channel: "email" | "sms" | "voice" | "linkedin";
  status: "queued" | "sent" | "delivered" | "replied" | "bounced" | "failed";
  metadata_json: string | null;
  created_at: string;
}

export interface InterviewRecord {
  id: number;
  person: string;
  transcript_path: string | null;
  jtbd: string | null;
  pain_quotes_json: string | null;
  created_at: string;
}

export interface OneShotConfig {
  walletMode: "cdp" | "private-key";
  llmProvider: "openrouter" | "openai" | "anthropic";
  llmModel: string;
  telemetryEnabled: boolean;
  founderName: string | null;
  founderEmail: string | null;
  productOneLiner: string | null;
}

export type PlayName =
  | "show-hn"
  | "job-change"
  | "post-funding"
  | "accelerator-batch"
  | "competitor-switch"
  | "hiring-signal"
  | "podcast-guest"
  | "demo-no-show"
  | "concierge"
  | "breakup-revive";
