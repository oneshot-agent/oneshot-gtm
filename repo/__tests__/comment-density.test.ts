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

  const edit = (lines: string[], removed: string[], file = "src/a.ts") =>
    counts(commentDensity(added(file, lines, removed)));

  it("whitespace inside a string literal is code", () => {
    expect(edit(['send("a b");'], ['send("a  b"); // old'])).toEqual([1, 0, 0]);
    expect(edit(['send("a  b");'], ['send("a  b");   // old'])).toEqual([0, 0, 1]);
  });

  it("a trailing comment that only changes its spacing is a comment edit", () => {
    expect(edit(["run(); // a b"], ["run(); // a  b"])).toEqual([0, 1, 1]);
  });

  it("a quote inside a regex literal does not hide the trailing comment", () => {
    expect(edit(['const quote = /"/;'], ['const quote = /"/; // old'])).toEqual([0, 0, 1]);
    expect(edit(["const h = a / 2 // halved"], ["const h = a / 2 // half"])).toEqual([0, 1, 1]);
  });

  it("`//` inside an inline block comment is not a trailing comment", () => {
    expect(
      edit(["const n = /* https://example */ 2;"], ["const n = /* https://example */ 1;"]),
    ).toEqual([1, 0, 0]);
    expect(edit(["f(/* a */ x);"], ["f(/* a */ x); // old"])).toEqual([0, 0, 1]);
  });

  it("a line pairs only with a removed line of the same file entry", () => {
    const other = [
      added("worker.py", [], ["refresh() # old"]),
      added("src/client.ts", ["refresh() // new"]),
    ].join("\n");
    expect(counts(commentDensity(other))).toEqual([1, 0, 0]);
    const renamed = [
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-refresh(); // old",
      "+refresh();",
    ].join("\n");
    expect(counts(commentDensity(renamed))).toEqual([0, 0, 1]);
  });
});
