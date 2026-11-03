import { expect, it } from "vitest";
import { linkedInError, linkedInFailure } from "../src/linkedin-error.ts";
import { linkedInMessageDeferral } from "../src/linkedin-message.ts";
it("retains safe provider detail and request ID without serializing the raw response", () => {
  const e = linkedInError({
    message: "Bad request",
    statusCode: 400,
    responseBody: JSON.stringify({
      message: "Unrecognized key: timeout",
      request_id: "r1",
      headers: { authorization: "secret" },
      token: "private",
    }),
  });
  expect(e).toMatchObject({
    message: "Bad request: Unrecognized key: timeout",
    statusCode: 400,
    requestId: "r1",
  });
  expect(JSON.stringify(e)).not.toContain("private");
  expect(JSON.stringify(e)).not.toContain("authorization");
});
it("retains accepted IDs and payment reasons, redacting credential-shaped details", () => {
  expect(
    linkedInError({ message: "Failed token=abc", jobId: "accepted", reason: "insufficient_funds" }),
  ).toMatchObject({
    message: "Failed [redacted]",
    requestId: "accepted",
    code: "insufficient_funds",
  });
});

it("keeps an async job's error text, so a deferral named only there survives the server transport", () => {
  const e = linkedInError({
    message: "Job failed",
    jobId: "j1",
    jobError: "linkedin/message: not_connected (token=abc)",
  });
  expect(e.jobError).toBe("linkedin/message: not_connected ([redacted]");
  expect(linkedInMessageDeferral(e)).toBe("not_connected");
  expect(
    linkedInMessageDeferral(linkedInError({ message: "Job failed", jobError: "rate_limited" })),
  ).toBe("rate_limited");
  expect(
    linkedInMessageDeferral(linkedInError({ message: "Job failed", jobError: "boom" })),
  ).toBeNull();
  expect(linkedInError({ message: "x" })).not.toHaveProperty("jobError");
});

it("keeps a failed job's reason and LinkedIn's upstream reason apart from the code, and shows them", () => {
  const e = linkedInError(
    Object.assign(new Error("Job failed: recipient_unavailable"), {
      name: "JobError",
      code: "recipient_unavailable",
      partialResult: { reason: "recipient_unavailable", upstream_reason: "invalid_recipient" },
    }),
  );
  expect(e).toMatchObject({
    code: "recipient_unavailable",
    reason: "recipient_unavailable",
    upstreamReason: "invalid_recipient",
    message: "Job failed: recipient_unavailable (invalid_recipient)",
  });
  // Already carried by the error (from the worker): kept as is.
  expect(
    linkedInError({ name: "JobError", message: "Job failed", code: "x", upstreamReason: "y" }),
  ).toMatchObject({ code: "x", upstreamReason: "y", message: "Job failed (x: y)" });
});

it("reads OneShot's failed-job format: the code from `code`, the sentence and provider type from partialResult", () => {
  const e = linkedInError(
    Object.assign(new Error("Job failed: This person can't be invited right now."), {
      name: "JobError",
      code: "recipient_unavailable",
      jobError: "This person can't be invited right now.",
      partialResult: {
        reason: "This person can't be invited right now.",
        upstream_reason: "invalid_recipient",
      },
    }),
  );
  expect(e).toMatchObject({
    code: "recipient_unavailable",
    reason: "This person can't be invited right now.",
    upstreamReason: "invalid_recipient",
    message:
      "Job failed: This person can't be invited right now. (recipient_unavailable: invalid_recipient)",
  });
  // The sentence is never a code, whatever it mentions.
  expect(
    linkedInFailure({ name: "JobError", jobError: "We were rate limited, try later." }),
  ).toEqual({ code: null, reason: "We were rate limited, try later.", upstream: null });
  // The older format: `jobError` is the code itself.
  expect(linkedInFailure({ name: "JobError", jobError: "rate_limited" })).toEqual({
    code: "rate_limited",
    reason: null,
    upstream: null,
  });
});

it("keeps a 409 duplicate_request's status, code and original request id", () => {
  const e = linkedInError({
    name: "ToolError",
    message: "Tool request failed",
    statusCode: 409,
    responseBody: JSON.stringify({
      error: "duplicate_request",
      message: "A request with this idempotency key already exists",
      details: { request_id: "req-orig" },
    }),
  });
  expect(e).toMatchObject({ statusCode: 409, code: "duplicate_request", requestId: "req-orig" });
});

it("never takes a sentence in the body's `error` for a code", () => {
  const e = linkedInError({
    name: "ToolError",
    message: "Tool request failed",
    statusCode: 400,
    responseBody: JSON.stringify({ error: "Unrecognized key: timeout" }),
  });
  expect(e.code).toBeUndefined();
  expect(linkedInMessageDeferral(e)).toBeNull();
});
