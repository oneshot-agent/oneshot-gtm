import { PDFDocument, StandardFonts } from "pdf-lib";

/** Preserve uploaded PDFs; fit JPEG artwork to a U.S. letter sheet without cropping. */
export async function letterArtworkPdf(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new Error("Choose a PDF or JPEG up to 20 MB");
  try {
    if (mime === "application/pdf") {
      const doc = await PDFDocument.load(bytes);
      if (!doc.getPageCount()) throw new Error("Empty PDF");
      return bytes;
    }
    if (mime !== "image/jpeg") throw new Error("Unsupported format");
    const doc = await PDFDocument.create();
    const image = await doc.embedJpg(bytes);
    const page = doc.addPage([612, 792]);
    const scale = Math.min(540 / image.width, 720 / image.height);
    const width = image.width * scale,
      height = image.height * scale;
    page.drawImage(image, { x: (612 - width) / 2, y: (792 - height) / 2, width, height });
    return await doc.save();
  } catch {
    throw new Error("Could not read this artwork. Upload an unlocked PDF or a valid JPEG.");
  }
}

export async function renderMailLetter(body: string): Promise<Uint8Array> {
  if (!body.trim() || body.length > 12000)
    throw new Error("Letter must contain 1–12,000 characters");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  let page = doc.addPage([612, 792]),
    y = 720;
  const line = (text: string) => {
    if (y < 72) {
      page = doc.addPage([612, 792]);
      y = 720;
    }
    page.drawText(text, { x: 72, y, size: 12, font });
    y -= 18;
  };
  try {
    for (const paragraph of body.replace(/\r/g, "").split("\n")) {
      let buffer = "";
      for (const word of paragraph.split(/\s+/)) {
        if (font.widthOfTextAtSize(word, 12) > 468)
          throw new Error("A word or URL is too long for the letter");
        const next = buffer ? `${buffer} ${word}` : word;
        if (font.widthOfTextAtSize(next, 12) > 468) {
          line(buffer);
          buffer = word;
        } else buffer = next;
      }
      line(buffer);
    }
  } catch (error) {
    throw new Error(
      `Unable to render letter text: ${error instanceof Error ? error.message : "unsupported characters"}`,
      { cause: error },
    );
  }
  return doc.save();
}
