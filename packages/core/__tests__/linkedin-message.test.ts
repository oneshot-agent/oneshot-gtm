import { expect, it } from "vitest";
import { linkedInMessageConversationId, linkedInMessageDeferral } from "../src/linkedin-message.ts";

it("reads the conversation id from a send result, null when absent or empty", () => {
  expect(linkedInMessageConversationId({ conversation_id: "c1" })).toBe("c1");
  expect(linkedInMessageConversationId({ status: "sent" })).toBeNull();
  expect(linkedInMessageConversationId({ conversation_id: null })).toBeNull();
  expect(linkedInMessageConversationId({ conversation_id: " " })).toBeNull();
  expect(linkedInMessageConversationId(null)).toBeNull();
});

it("treats not_connected and rate_limited as deferrals, whatever field carries them", () => {
  expect(linkedInMessageDeferral({ code: "not_connected" })).toBe("not_connected");
  expect(linkedInMessageDeferral({ reason: "rate_limited" })).toBe("rate_limited");
  // An older answer with no code names it in its job text.
  expect(linkedInMessageDeferral({ jobError: "failed: rate_limited today" })).toBe("rate_limited");
  expect(linkedInMessageDeferral({ jobError: "failed: recipient_not_connected" })).toBe(
    "not_connected",
  );
  // Glued to a letter or digit on either side: not the code.
  expect(linkedInMessageDeferral({ jobError: "failed: Xrate_limited" })).toBeNull();
  expect(linkedInMessageDeferral({ jobError: "failed: not_connected2" })).toBeNull();
  // A code decides: a job's sentence never overrides it.
  expect(linkedInMessageDeferral({ code: "x", jobError: "failed: rate_limited today" })).toBeNull();
  expect(
    linkedInMessageDeferral({
      name: "JobError",
      code: "recipient_unavailable",
      jobError: "LinkedIn rate_limited this account earlier; the recipient can't be reached.",
    }),
  ).toBeNull();
  expect(linkedInMessageDeferral({ code: "boom" })).toBeNull();
  expect(linkedInMessageDeferral(new Error("not_connected mentioned in a message"))).toBeNull();
  expect(linkedInMessageDeferral(null)).toBeNull();
});

it("reads OneShot's recipient_not_connected as not_connected, in a code or a job's text", () => {
  expect(linkedInMessageDeferral({ code: "recipient_not_connected" })).toBe("not_connected");
  expect(linkedInMessageDeferral({ reason: "recipient_not_connected" })).toBe("not_connected");
  // `\b` never matched after an underscore; the job's text still names it.
  expect(linkedInMessageDeferral({ jobError: "Job failed: recipient_not_connected" })).toBe(
    "not_connected",
  );
  expect(linkedInMessageDeferral({ jobError: "recipient_not_connected_yet" })).toBeNull();
  expect(linkedInMessageDeferral({ jobError: "xnot_connected" })).toBeNull();
});
