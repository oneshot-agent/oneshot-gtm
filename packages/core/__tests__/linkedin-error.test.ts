import { expect, it } from "vitest";
import { linkedInError } from "../src/linkedin-error.ts";
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
