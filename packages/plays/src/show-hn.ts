import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
export { receiptUrls } from "./_lib.ts";

export interface ShowHnTarget {
  postTitle: string;
  postUrl: string;
  founderName: string;
  founderEmail: string;
  hookSummary: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface ShowHnRunOptions {
  dryRun: boolean;
  targets: ShowHnTarget[];
}

export interface ShowHnRunResult {
  drafted: Array<{
    target: ShowHnTarget;
    subject: string;
    body: string;
    receiptIds: number[];
    sent: boolean;
    flags: string[];
  }>;
}

const PLAY_NAME = "show-hn";

const showHnDef: EmailPlayDef<ShowHnTarget> = {
  playName: PLAY_NAME,
  promptName: "show-hn-email",
  maxBodyWords: 90,
  toEmail: (t) => t.founderEmail,
  // Enrich on both preview and real send (cached by email) so the reviewed
  // draft is personalized; the heavier deepResearch stays real-send only.
  prepare: (t, dryRun) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: { email: t.founderEmail, name: t.founderName },
      enrichSlice: 3500,
      ...(dryRun
        ? {}
        : {
            research: {
              topic: `Recent public work and engineering decisions by ${t.founderName} on ${t.postTitle}`,
            },
          }),
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `SHOW HN: ${t.postTitle}`,
      `URL: ${t.postUrl}`,
      `HOOK: ${t.hookSummary}`,
      `DOSSIER:\n${prep.dossier || "(dry-run; rely on the hook only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.founderName,
    email: t.founderEmail,
    company: extractCompany(t.postTitle),
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "show-hn",
  }),
  metadata: (t) => ({ postUrl: t.postUrl, postTitle: t.postTitle }),
};

export function runShowHn(opts: ShowHnRunOptions): Promise<ShowHnRunResult> {
  return runEmailPlay(showHnDef, opts);
}

function extractCompany(title: string): string | null {
  const m = title.match(/Show HN:\s*([^\s—–:|-]+)/i);
  return m ? (m[1] ?? null) : null;
}
