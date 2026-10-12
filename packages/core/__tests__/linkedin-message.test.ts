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
  expect(linkedInMessageDeferral({ code: "x", jobError: "failed: rate_limited today" })).toBe(
    "rate_limited",
  );
  expect(linkedInMessageDeferral({ code: "boom" })).toBeNull();
  expect(linkedInMessageDeferral(new Error("not_connected mentioned in a message"))).toBeNull();
  expect(linkedInMessageDeferral(null)).toBeNull();
});
