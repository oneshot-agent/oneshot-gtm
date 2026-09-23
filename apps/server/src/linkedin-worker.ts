import { linkedInError, linkedInSdk, type LinkedInOperation } from "@oneshot-gtm/core";

// Separate process: config and credentials bind once to the account's originating workspace.
try {
  const result = await linkedInSdk((await Bun.stdin.json()) as LinkedInOperation);
  process.stdout.write(JSON.stringify({ result }));
} catch (e) {
  const error = linkedInError(e);
  process.stdout.write(JSON.stringify({ ...error, error: error.message }));
  process.exitCode = 1;
}
