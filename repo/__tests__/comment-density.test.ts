import { describe, expect, it } from "vitest";
import { type CommentDensity, commentDensity } from "../../scripts/comment-density.ts";

/** A one-file `git diff -U0` that replaces `removed` with `lines` at line 1. */
function added(file: string, lines: string[], removed: string[] = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${lines.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}
const notes = (n: number, mark = "// old") =>
  Array.from({ length: n }, (_, i) => `${mark} note ${i}`);
const counts = (r: CommentDensity) => [r.code, r.comments, r.removedComments];

describe("comment-density trailing comments", () => {
  it("changing only the trailing comment of a code line adds no code", () => {
    const r = commentDensity(
      added(
        "src/a.ts",
        ["price: 1000,", '.eq("status", expectedLockStatus) // Only on match'],
        [
          "price: 1000,     // Price in cents ($10.00)",
          '.eq("status", expectedLockStatus) // Only update if status matches expected',
        ],
      ),
    );
    expect(counts(r)).toEqual([0, 1, 2]);
    const trim = [...notes(30), "const total = 1000; // Price in cents ($10.00)"];
    expect(
      commentDensity(added("src/a.ts", [...notes(12, "//"), "const total = 1000;"], trim))
        .violations,
    ).toEqual([]);
  });

  it("changed code with a comment still counts as code, and a removed line pairs once", () => {
    const r = commentDensity(
      added(
        "src/a.ts",
        ["price: 2000, // Price in cents", 'log("// x");', "x: 1,", "x: 1,", "moved();"],
        ["price: 1000, // Price in cents", 'log("// y");', "x: 1, // old", "moved();"],
      ),
    );
    expect(counts(r)).toEqual([4, 0, 1]);
  });
});
