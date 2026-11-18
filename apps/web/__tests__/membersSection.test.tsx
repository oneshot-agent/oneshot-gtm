import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MembersView } from "@oneshot-gtm/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MembersSection } from "../src/components/setup/MembersSection.tsx";

const owner = { email: "owner@example.com", name: "Olive", role: "owner" as const };
const member = { email: "mia@example.com", name: "Mia", role: "member" as const };
const addedAt = "2026-11-18T12:00:00.000Z";
const view: MembersView = {
  members: [
    { ...owner, addedAt },
    { ...member, addedAt },
  ],
  allowedHosts: ["gtm.example.ts.net"],
  currentMember: owner,
};
function render(data: MembersView) {
  const client = new QueryClient();
  client.setQueryData(["members"], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MembersSection onDirtyChange={() => {}} />
    </QueryClientProvider>,
  );
}

it("shows member details, allowed hosts and owner controls in the Setup section", () => {
  const html = render(view);
  expect(html).toContain('id="members"');
  for (const text of [
    owner.email,
    owner.name,
    member.email,
    member.name,
    "owner",
    "member",
    view.allowedHosts[0]!,
  ]) {
    expect(html).toContain(text);
  }
  expect(html).toContain(`dateTime="${addedAt}"`);
  expect(html).toContain("Member email");
  expect(html).toContain("Add member");
  expect(html).toContain(`aria-label="Role for ${member.email}"`);
  expect(html).toContain(`aria-label="Remove ${member.email}"`);
});

it("shows members a read-only list", () => {
  const html = render({ ...view, currentMember: member });
  expect(html).toContain(owner.email);
  expect(html).toContain("Only owners can manage members.");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<select");
  expect(html).not.toContain('aria-label="Remove');
  expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
});

it("disables removal and demotion of the last owner", () => {
  const html = render(view);
  expect(html.match(/<select[^>]*aria-label="Role for owner@example.com"[^>]*>/)?.[0]).toContain(
    'disabled=""',
  );
  expect(html.match(/<button[^>]*aria-label="Remove owner@example.com"[^>]*>/)?.[0]).toContain(
    'disabled=""',
  );
  expect(html.match(/<select[^>]*aria-label="Role for mia@example.com"[^>]*>/)?.[0]).not.toContain(
    'disabled=""',
  );
});

it("explains an empty install and keeps local owner access to adding members", () => {
  const html = render({
    members: [],
    allowedHosts: [],
    currentMember: { email: null, name: null, role: "owner" },
  });
  expect(html).toContain("No members yet. This machine has local owner access.");
  expect(html).toContain("none (loopback on this machine only)");
  expect(html).toContain("Member email");
});
