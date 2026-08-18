import { existsSync, readFileSync } from "node:fs";
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
