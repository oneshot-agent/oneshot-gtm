import { linkedInSdk, type LinkedInOperation } from "@oneshot-gtm/core";

// Separate process: config and credentials bind once to the account's originating workspace.
try {
  const result = await linkedInSdk((await Bun.stdin.json()) as LinkedInOperation);
  process.stdout.write(JSON.stringify({ result }));
} catch (e) {
  const error = e as Error & {
    statusCode?: number;
    requestId?: string;
    jobId?: string;
    code?: string;
  };
  process.stdout.write(
    JSON.stringify({
      error: error.message,
      name: error.name,
      statusCode: error.statusCode,
      requestId: error.requestId ?? error.jobId,
      code: error.code,
    }),
  );
  process.exitCode = 1;
}
