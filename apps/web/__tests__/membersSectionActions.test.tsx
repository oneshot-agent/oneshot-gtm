import type { ComponentProps } from "react";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { MembersSection } from "../src/components/setup/MembersSection.tsx";

const form = vi.hoisted(() => ({
  email: "draft@example.com",
  submit: () => {},
  edit: (_value: string) => {},
}));
let client: QueryClient;
let observer: MutationObserver;
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      typeof initial === "string"
        ? [
            form.email,
            (value: string) => {
              form.email = value;
            },
          ]
        : actual.useState(initial),
  };
});
// Static renders do not retain hooks; keep the real mutation observer across renders.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useMutation: (options: ConstructorParameters<typeof MutationObserver>[1]) => {
      observer ??= new actual.MutationObserver(client, options);
      observer.setOptions(options);
      return {
        ...observer.getCurrentResult(),
        mutate: (variables: never) => {
          void observer.mutate(variables).catch(() => {});
        },
      };
    },
  };
});
vi.mock("../src/components/setup/SectionShell.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/setup/SectionShell.tsx")>();
  return {
    SectionShell: (props: ComponentProps<typeof actual.SectionShell>) => {
      form.submit = props.onSubmit;
      return <actual.SectionShell {...props} />;
    },
  };
});
vi.mock("../src/components/primitives/Field.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/primitives/Field.tsx")>();
  return {
    ...actual,
    Input: (props: ComponentProps<typeof actual.Input>) => {
      form.edit = (value: string) => props.onChange!({ target: { value } } as never);
      return <actual.Input {...props} />;
    },
  };
});
function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MembersSection onDirtyChange={() => {}} />
    </QueryClientProvider>,
  );
}
function setup(status: number) {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  observer = undefined!;
  form.email = "draft@example.com";
  const currentMember = { email: "owner@example.com", name: "Owner", role: "owner" };
  client.setQueryData(["members"], { members: [], allowedHosts: [], currentMember });
  client.setQueryData(["me"], currentMember);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ error: "Write refused" }, { status })),
  );
  render();
}
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

it.each([403, 404, 409])(
  "refreshes roster and identity after %s without losing the add draft",
  async (status) => {
    setup(status);
    form.submit();
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(client.getQueryState(["members"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["me"])?.isInvalidated).toBe(true);
    expect(form.email).toBe("draft@example.com");
    expect(render()).toContain("Write refused");
  },
);
