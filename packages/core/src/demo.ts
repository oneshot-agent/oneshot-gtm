import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "./config.ts";

// Demo mode exists for one reason: capturing a screenshot or a video of a
// populated dashboard without a real ledger full of real prospects. It is a
// READ-ONLY seam. Four calls the dashboard makes at request time can't be
// populated by seeding SQLite, because they fetch from the network rather than
// the ledger — the reply list, the platform RoCS rollup, the provisioned-domain
// pool, and the wallet balance. In demo mode those four read a JSON fixture
// written by `demo seed` instead.
//
// Nothing that sends, drafts, spends or writes is faked. The demo home carries
// placeholder credentials, so a stray click on Run or Send fails at auth — which
// is the intended behavior, not a limitation to paper over.

/** True when the process was launched against a seeded demo home (`demo ui`). */
export function demoMode(): boolean {
  return process.env["ONESHOT_GTM_DEMO"] === "1";
}

/**
 * What an absolute path becomes in a demo response.
 *
 * A demo install exists to be photographed and published, and the dashboard
 * prints its own paths back at itself: doctor names the config dir, the ledger
 * file and the .env it wants a token added to, and the masthead names the
 * workspace home. Every one of those carries the operator's home directory.
 *
 * That leak is not hypothetical. It shipped as far as a re-shot Today capture,
 * where the health panel had auto-expanded and printed
 * /Users/<name>/.oneshot-gtm-demo-site four times, before anyone noticed.
 * Scrubbing at the point every response is serialised means a demo install
 * cannot emit one at all — screenshots, captured fixtures, video and anything
 * else that reads it are covered by construction rather than by remembering.
 */
export const DEMO_HOME_PLACEHOLDER = "/home/founder/.oneshot-gtm";

/**
 * Replace absolute paths in an already-serialised demo response.
 *
 * Runs over the JSON text rather than the object so it reaches paths embedded
 * mid-sentence — doctor's hints are prose, not fields. The demo home goes
 * first so it lands on the placeholder whole; whatever absolute path is left
 * belongs to the machine rather than the install, and collapses to the
 * placeholder's parent.
 */
export function scrubDemoPaths(json: string, home: string): string {
  let out = json;
  for (const form of pathForms(home)) out = out.split(form).join(DEMO_HOME_PLACEHOLDER);
  for (const form of pathForms(homedir())) out = out.split(form).join("/home/founder");
  return out;
}

/** A path as it can appear in JSON text: literal, and backslash-escaped. */
function pathForms(p: string): string[] {
  return [p, p.replaceAll("\\", "\\\\")];
}

/** Directory `demo seed` writes its network-read fixtures into. */
export function demoFixtureDir(): string {
  return join(configDir(), "demo");
}

/**
 * Read one fixture from the demo home. Returns null when it's missing or
 * unparseable, so callers fall through to their normal path — a half-seeded
 * demo home degrades to real behavior rather than throwing mid-render.
 */
export function demoFixture<T>(name: string): T | null {
  const path = join(demoFixtureDir(), name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
