import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/html-text.ts";

describe("htmlToText", () => {
  it("strips tags and keeps the text", () => {
    expect(htmlToText("<b>Hey</b> there, <i>Mira</i>.")).toBe("Hey there, Mira.");
  });

  it("turns structural breaks into newlines", () => {
    expect(htmlToText("<p>line one</p><p>line two</p>")).toBe("line one\nline two");
    expect(htmlToText("first<br>second<br/>third")).toBe("first\nsecond\nthird");
    expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\nb");
  });

  it("decodes the entities that actually occur in mail", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#39;apos&#39;&nbsp;end")).toBe(
      "Tom & Jerry <3 \"quotes\" 'apos' end",
    );
    expect(htmlToText("&#8364;21 and &#x20AC;22")).toBe("€21 and €22");
  });

  it("drops script, style, head and comments entirely", () => {
    const html =
      "<head><title>t</title></head><style>.a{color:red}</style>" +
      "<script>alert('x')</script><!-- hidden -->visible";
    expect(htmlToText(html)).toBe("visible");
  });

  it("collapses runs of blank lines left by nested markup", () => {
    const html = "<div><p>one</p></div>\n\n<div>\n<p>two</p>\n</div>";
    expect(htmlToText(html)).toBe("one\n\ntwo");
  });

  it("survives a typical HTML-only reply", () => {
    const html =
      '<div dir="ltr">Thanks for reaching out!<br><br>Thursday works.<div><br></div>' +
      "<div>— Jane</div></div>";
    expect(htmlToText(html)).toBe("Thanks for reaching out!\n\nThursday works.\n\n— Jane");
  });

  it("returns empty for empty or tag-only input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<div><br/></div>")).toBe("");
  });

  it("leaves malformed numeric entities out rather than throwing", () => {
    expect(htmlToText("&#x110000; ok")).toBe("ok");
  });

  // Hardening (CodeQL js/incomplete-multi-character-sanitization /
  // js/bad-tag-filter): a single replace pass can reassemble the construct it
  // just removed, and spec-legal end tags carry junk before the `>`.
  it("removes script content even with a nested-tag reassembly trick", () => {
    expect(htmlToText("<scr<script>x</script>ipt>alert(1)</scr</script>ipt>ok")).not.toContain(
      "alert",
    );
  });

  it("removes script blocks whose end tag carries whitespace and junk", () => {
    expect(htmlToText("<script>var x = 1;</script\t\n bar>after")).toBe("after");
  });

  it("removes style blocks with attributes on the open tag", () => {
    expect(htmlToText('<style type="text/css">.a{}</style >text')).toBe("text");
  });

  it("never leaves an assembled comment opener behind", () => {
    expect(htmlToText("<!<!--- x --->--> visible")).not.toContain("<!--");
  });

  it("drops an unclosed script block to end-of-input instead of leaking it", () => {
    expect(htmlToText("before<script>var secret = 1;")).toBe("before");
  });

  it("stays fast on input stuffed with close-tag prefixes (ReDoS guard)", () => {
    const hostile = `<script>${"</script".repeat(20_000)}`;
    const t0 = performance.now();
    const out = htmlToText(hostile);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out).not.toContain("script");
  });

  it("stays fast on input stuffed with comment openers (ReDoS guard)", () => {
    const hostile = `${"<!--".repeat(40_000)}tail`;
    const t0 = performance.now();
    const out = htmlToText(hostile);
    expect(performance.now() - t0).toBeLessThan(1_000);
    // The first opener never closes, so everything after it is comment.
    expect(out).toBe("");
  });

  it("drops an unclosed comment to end-of-input, per spec", () => {
    expect(htmlToText("before<!-- never closed")).toBe("before");
  });

  // Review findings on #33 — each of these destroyed or leaked real content.
  it("preserves comparison operators in prose", () => {
    expect(htmlToText("<p>Revenue < $1m and growth > 20%</p>")).toBe(
      "Revenue < $1m and growth > 20%",
    );
  });

  it("treats attribute-bearing <br> as a line break (Gmail emits these)", () => {
    expect(htmlToText('Hello<br class="gmail_default">World')).toBe("Hello\nWorld");
  });

  it("does not let </scripture> close a script element", () => {
    // Spec: script content runs until a real close tag; a false-prefix close
    // would stop stripping early and leak script source into the body.
    expect(htmlToText("<script>var x;</scripture>more code</script>after")).toBe("after");
  });

  it("still strips to end-of-input when only false-prefix closers exist", () => {
    expect(htmlToText("before<script>var x;</scripture>leaked")).toBe("before");
  });
});
