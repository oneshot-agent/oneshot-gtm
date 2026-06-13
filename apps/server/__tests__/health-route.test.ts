import { beforeEach, describe, expect, it } from "vitest";
import { __resetInflight, beginDraining, beginSend, endSend } from "@oneshot-gtm/core";
import { health } from "../src/api/health.ts";

function req(): Request {
  return new Request("http://localhost/api/health", { headers: { host: "127.0.0.1:3030" } });
}

describe("health route — in-flight send count for the restart guard", () => {
  beforeEach(() => {
    __resetInflight();
  });

  it("reports zero in-flight sends and not draining when idle", async () => {
    const body = (await health(req()).json()) as {
      ok: boolean;
      inFlightSends: number;
      draining: boolean;
    };
    expect(body).toMatchObject({ ok: true, inFlightSends: 0, draining: false });
  });

  it("reflects the live in-flight count and draining flag", async () => {
    beginSend();
    beginSend();
    beginDraining();
    const busy = (await health(req()).json()) as { inFlightSends: number; draining: boolean };
    expect(busy).toMatchObject({ inFlightSends: 2, draining: true });

    endSend();
    endSend();
    const idle = (await health(req()).json()) as { inFlightSends: number };
    expect(idle.inFlightSends).toBe(0);
  });
});
