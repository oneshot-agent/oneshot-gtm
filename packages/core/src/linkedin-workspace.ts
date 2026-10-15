import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV_ONLY_SECRET_KEYS, SECRET_KEYS } from "./config.ts";
import { linkedInError } from "./linkedin-error.ts";
import { linkedInSdk, type LinkedInOperation } from "./linkedin-sdk.ts";
import { currentWorkspaceName } from "./shared-db.ts";
import { resolveWorkspaceHome } from "./workspaces.ts";

/**
 * Run a LinkedIn operation as the workspace that owns the account. OneShot
 * binds an account to the wallet that connected it, so a call for another
 * workspace's account runs in a child process with that workspace's home and
 * credentials. Shared by the server and the CLI: run from source the worker
 * is this package's `linkedin-worker.ts`; in the server's bundle it is the
 * `linkedin-worker.mjs` entry next to the bundle.
 */
export async function callLinkedInAs<T>(
  workspace: string,
  operation: LinkedInOperation,
): Promise<T> {
  if (workspace === currentWorkspaceName()) {
    try {
      return (await linkedInSdk(operation)) as T;
    } catch (e) {
      const error = linkedInError(e);
      throw Object.assign(new Error(error.message), error);
    }
  }
  const home = resolveWorkspaceHome(workspace);
  const source = join(import.meta.dir, "linkedin-worker.ts");
  const worker = existsSync(source) ? source : join(import.meta.dir, "linkedin-worker.mjs");
  const env: Record<string, string | undefined> = {
    ...process.env,
    ONESHOT_GTM_HOME: home,
    ONESHOT_GTM_WORKSPACE: workspace,
  };
  // Never let the requesting workspace's credentials shadow the account owner's .env.
  for (const key of [...SECRET_KEYS, ...ENV_ONLY_SECRET_KEYS]) delete env[key];
  const child = Bun.spawn([process.execPath, "run", worker], {
    cwd: home,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify(operation));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let data: {
      result: T;
      error?: string;
      name?: string;
      statusCode?: number;
      requestId?: string;
      code?: string;
      jobError?: string;
    };
    try {
      data = JSON.parse(stdout.trim());
    } catch {
      throw new Error("LinkedIn workspace worker stopped before returning a result");
    }
    if (code || data.error)
      throw Object.assign(new Error(data.error ?? "LinkedIn worker failed"), {
        name: data.name ?? "Error",
        statusCode: data.statusCode,
        requestId: data.requestId,
        code: data.code,
        // An async job's failure text names not_connected / rate_limited when
        // no code does; linkedInMessageDeferral reads it, so it crosses the worker.
        ...(typeof data.jobError === "string" ? { jobError: data.jobError } : {}),
      });
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}
