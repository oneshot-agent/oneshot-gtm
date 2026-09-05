import { describe, expect, it } from "vitest";
import { readMailArtwork } from "../src/api/mail-artwork.ts";
describe("mail artwork upload bounds", () => {
  it("accepts ordinary artwork bytes", async () => {
    expect(
      await readMailArtwork(
        new Request("http://local", { method: "POST", body: new Uint8Array([1, 2, 3]) }),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("rejects declared oversize before consuming the body", async () => {
    let consumed = false;
    const request = {
      headers: new Headers({ "content-length": String(21 * 1024 * 1024) }),
      body: {
        cancel: async () => {},
        getReader: () => {
          consumed = true;
          throw Error("read");
        },
      },
    } as unknown as Request;
    await expect(readMailArtwork(request)).rejects.toThrow("exceeds 20 MB");
    expect(consumed).toBe(false);
  });
  for (const declared of [undefined, "1"])
    it(`cancels oversized streams with length ${declared}`, async () => {
      let canceled = false;
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          canceled = true;
        },
      });
      const req = new Request("http://local", {
        method: "POST",
        body,
        headers: declared ? { "content-length": declared } : {},
      });
      await expect(readMailArtwork(req)).rejects.toThrow("exceeds 20 MB");
      expect(canceled).toBe(true);
    });
});
