/**
 * Demo mode: the real dashboard, over a ledger that was captured instead of queried.
 *
 * `vite build --mode demo` sets VITE_DEMO=1, and from there every read in
 * `client.ts` is served from a static file under `fixtures/` and every write is
 * refused before it can touch anything. The point is that this is the same
 * dashboard, the same routes and the same rendering — only the transport moved.
 * A demo built out of hand-written screens would be a mockup, and the product's
 * one unfakeable claim is that it does not deal in those.
 *
 * The fixtures are captured from a real `demo ui` server running against the
 * seeded home (see scripts/capture-fixtures.ts). Everything in them is a
 * response that server actually returned.
 *
 * Writes are refused HERE, at the transport, and not by disabling buttons alone.
 * A disabled button is a courtesy that a determined click can walk around; this
 * is the guarantee. `main.tsx` turns the throw into one consistent toast, so all
 * 36 mutation sites in the app report the same thing without knowing about demo
 * mode at all.
 */

import { fixturePath } from "./fixturePath.ts";

export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

/** `/demo/fixtures/` in a demo build, because vite's base is `/demo/`. */
const ROOT = `${import.meta.env.BASE_URL}fixtures/`;

/**
 * A write, refused. Carries a flag rather than relying on the class surviving,
 * because a rebuilt chunk boundary should not be able to break the check.
 */
export class DemoReadOnlyError extends Error {
  readonly demoReadOnly = true;
  constructor(readonly apiPath: string) {
    super("Read-only demo: this action is disabled here.");
    this.name = "DemoReadOnlyError";
  }
}

export function isDemoReadOnly(err: unknown): err is DemoReadOnlyError {
  return typeof err === "object" && err !== null && "demoReadOnly" in err;
}

/**
 * A read whose fixture was never captured.
 *
 * The capture script enumerates the URL space the UI can ask for and then
 * crawls the app to catch what it missed, so this should be unreachable. It
 * says which file was wanted anyway: a demo that fails silently is worse than
 * one that fails legibly, and the file name is the whole repro.
 */
export class DemoMissingFixtureError extends Error {
  constructor(apiPath: string, file: string) {
    // Two audiences. The message is what a route prints on the page, so it
    // says what happened in terms a visitor can act on. The file name is the
    // whole repro and belongs in the console, where whoever re-captures looks.
    super(
      `This corner of the demo was not captured. It is a snapshot, and ${apiPath} is not in it.`,
    );
    this.name = "DemoMissingFixtureError";
    console.error(`[demo] no fixture for ${apiPath} \u2014 expected ${file}`);
    reportMiss(apiPath);
  }
}

/** Fires when a fixture turns up missing, so the frame can say so. */
export const DEMO_MISS_EVENT = "oneshot-gtm:demo-fixture-miss";

const missed = new Set<string>();

/**
 * A miss, recorded where both a visitor and a build script can see it.
 *
 * The routes were written against a server that answers, so some of them read
 * a failed query as an empty one: Replies with no fixture renders "No
 * conversations yet." On a site whose argument is that nothing in it was
 * invented, a fetch failure that reads as a real result is the worst way this
 * can break, and it breaks quietly.
 *
 * So DemoFrame shows a line, and the attribute on <html> lets `pull-demo`'s
 * headless sweep catch the same thing before any of it is vendored.
 */
function reportMiss(apiPath: string): void {
  missed.add(apiPath);
  document.documentElement.dataset["demoFixtureMiss"] = [...missed].join(" ");
  window.dispatchEvent(new CustomEvent(DEMO_MISS_EVENT));
}

/*
 * Responses are held for the life of the page.
 *
 * Several routes poll — Receipts every 20s, Today every 15s, the nav's alert
 * queries every 60s. Against a static file that would be a request per tick
 * for a document that cannot have changed, on every open tab, forever. The
 * memo makes polling free, which is what lets demo mode leave the routes'
 * refetch intervals exactly as the product ships them.
 *
 * In-flight promises are cached too, not just resolved values: Today fires
 * three queries against overlapping paths on first paint.
 */
const cache = new Map<string, Promise<unknown>>();

export function demoGet<T>(apiPath: string): Promise<T> {
  const hit = cache.get(apiPath);
  if (hit) return hit as Promise<T>;

  const file = fixturePath(apiPath);
  const pending = fetch(ROOT + file).then(async (res) => {
    if (!res.ok) {
      // A miss is permanent, so it must not stay in the cache poisoning every
      // later poll of the same path with a promise that can never resolve.
      cache.delete(apiPath);
      throw new DemoMissingFixtureError(apiPath, file);
    }
    return res.json();
  });

  cache.set(apiPath, pending);
  return pending as Promise<T>;
}

export function demoWrite(apiPath: string): never {
  throw new DemoReadOnlyError(apiPath);
}
