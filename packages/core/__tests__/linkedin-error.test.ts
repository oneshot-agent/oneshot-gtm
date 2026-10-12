import { expect, it } from "vitest";
import { linkedInError } from "../src/linkedin-error.ts";
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
