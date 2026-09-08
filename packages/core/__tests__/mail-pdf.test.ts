import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { letterArtworkPdf, renderMailLetter } from "../src/mail-pdf.ts";
describe("mail print artwork", () => {
  it("renders a letter with real PDF pages and preserves an uploaded PDF byte-for-byte", async () => {
    const bytes = await renderMailLetter("Dear Jane,\n\nA useful follow-up for Acme.\n\nAlex");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(await letterArtworkPdf(bytes, "application/pdf")).toEqual(bytes);
  });
  it("fits JPEG artwork onto a letter sheet without cropping", async () => {
    const jpg = new Uint8Array(
      readFileSync(new URL("./fixtures/mail-artwork.jpg", import.meta.url)),
    );
    const converted = await letterArtworkPdf(jpg, "image/jpeg");
    const doc = await PDFDocument.load(converted);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const objects = doc.context
      .enumerateIndirectObjects()
      .map(([, object]) => object.toString())
      .join("\n");
    expect(objects).toContain("/DCTDecode");
    expect(objects).toContain("/Width 64");
    expect(objects).toContain("/Height 32");
  });
  it("paginates long letters instead of clipping text off the sheet", async () => {
    const doc = await PDFDocument.load(
      await renderMailLetter(Array.from({ length: 90 }, (_, i) => `Line ${i}`).join("\n")),
    );
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
  it("rejects invalid files, empty content, and words that cannot fit", async () => {
    await expect(letterArtworkPdf(new Uint8Array([1, 2, 3]), "image/jpeg")).rejects.toThrow(
      "valid JPEG",
    );
    await expect(letterArtworkPdf(new Uint8Array([1, 2, 3]), "application/pdf")).rejects.toThrow(
      "unlocked PDF",
    );
    await expect(renderMailLetter(" ")).rejects.toThrow();
    await expect(renderMailLetter("x".repeat(300))).rejects.toThrow("too long");
  });
});
