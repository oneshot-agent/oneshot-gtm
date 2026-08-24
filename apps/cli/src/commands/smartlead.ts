import {
  listSmartleadAccounts,
  loadConfig,
  registerSmartleadIdentity,
  resolveIdentities,
  saveSecrets,
  secretsPath,
  smartleadApiKey,
  type SmartleadAccount,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * `smartlead connect` — store the workspace API key and add Smartlead-hosted
 * mailboxes to the sender rotation pool. Send-only: Smartlead does the warmup
 * and hosts the inboxes; replies to Smartlead-sent mail are read in
 * Smartlead's own UI. The key is validated against the accounts API BEFORE it
 * is saved, so a typo never lands in .env.
 */
export async function commandSmartleadConnect(): Promise<void> {
  header("Connect Smartlead");

  async function promptForKey(message: string): Promise<string> {
    const answer = await prompts(
      {
        type: "password",
        name: "key",
        message,
        validate: (v: string) => (v.trim().length > 0 ? true : "required"),
      },
      { onCancel: () => process.exit(0) },
    );
    return ((answer["key"] as string) ?? "").trim();
  }

  let key = smartleadApiKey();
  let keyIsNew = false;
  if (key) {
    note("Using the stored SMARTLEAD_API_KEY.");
  } else {
    key = await promptForKey("Smartlead API key (Smartlead → Settings → API)");
    if (!key) {
      warn("No key provided.");
      return;
    }
    keyIsNew = true;
  }

  let accounts: SmartleadAccount[] | null = null;
  try {
    accounts = await listSmartleadAccounts(key);
  } catch (err) {
    warn(`Smartlead rejected the request: ${(err as Error).message}`);
    if (keyIsNew) {
      note("The key was NOT saved.");
      return;
    }
    // The STORED key failed (revoked, expired, wrong workspace). Without this
    // re-prompt the command is a dead end: every rerun reads the same bad key.
    key = await promptForKey("Stored key rejected — paste a replacement key (esc to cancel)");
    if (!key) {
      warn("No key provided.");
      return;
    }
    keyIsNew = true;
    try {
      accounts = await listSmartleadAccounts(key);
    } catch (err2) {
      warn(`Smartlead rejected the replacement too: ${(err2 as Error).message}`);
      note("The key was NOT saved.");
      return;
    }
  }
  if (keyIsNew) {
    saveSecrets({ SMARTLEAD_API_KEY: key });
    ok(`Key validated and saved to ${secretsPath()} (chmod 600).`);
  }

  if (accounts.length === 0) {
    warn(
      "No email accounts connected in this Smartlead workspace yet — add mailboxes there first.",
    );
    return;
  }

  const registered = new Set(
    resolveIdentities(loadConfig())
      .filter((i) => i.provider === "smartlead")
      .map((i) => i.address?.trim().toLowerCase()),
  );

  const choices = accounts.map((a) => {
    const inPool = registered.has(a.fromEmail);
    const broken = !a.isSmtpSuccess;
    const detail = [
      a.messagePerDay != null ? `${a.messagePerDay}/day` : "no cap",
      a.warmupStatus
        ? `warmup ${a.warmupStatus.toLowerCase()}${a.warmupReputation ? ` (${a.warmupReputation})` : ""}`
        : "warmup unknown",
    ].join(" · ");
    return {
      title: `${a.fromEmail} — ${detail}${inPool ? " — already in pool" : ""}${broken ? " — SMTP broken" : ""}`,
      value: a,
      disabled: inPool || broken,
    };
  });
  const picked = await prompts(
    {
      type: "multiselect",
      name: "accounts",
      message: "Mailboxes to add to the rotation pool",
      choices,
      hint: "space to select · enter to confirm",
    },
    { onCancel: () => process.exit(0) },
  );
  const selection = (picked["accounts"] as SmartleadAccount[] | undefined) ?? [];
  if (selection.length === 0) {
    note("Nothing selected — the pool is unchanged.");
    return;
  }

  for (const a of selection) {
    const { identityId, created } = registerSmartleadIdentity({
      address: a.fromEmail,
      label: a.fromName,
      providerMessagePerDay: a.messagePerDay,
    });
    if (created) {
      const cap = Math.min(50, a.messagePerDay && a.messagePerDay > 0 ? a.messagePerDay : 50);
      ok(`+ ${c.cyan(identityId)} (cap ${cap}/day, warm-up 10 +10/wk)`);
    } else {
      note(`= ${identityId} already in the pool (caps unchanged)`);
    }
  }
  note(
    "Send-only for now: replies to Smartlead-sent mail appear in Smartlead's inbox, not /inbox.",
  );
}
