import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, Input, Select, Textarea } from "../src/components/primitives/Field.tsx";

describe("Field accessibility", () => {
  it("keeps help outside labels and renders error and hint together", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Daily cap",
        explain: "warmup",
        hint: "Keep this guidance",
        error: "Invalid number",
        children: createElement(
          "div",
          null,
          createElement(Input, { id: "cap", "aria-describedby": "existing" }),
          createElement("button", { type: "button" }, "Helper"),
        ),
      }),
    );
    expect(html).toContain('for="cap"');
    expect(html).toContain('id="cap"');
    expect(html).toContain("Keep this guidance");
    expect(html).toContain("Invalid number");
    expect(html).toMatch(/aria-describedby="existing [^"]+-hint [^"]+-error"/);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-label="Explain Warm-up ramp"');
    expect(html.match(/<label[^>]*>[\s\S]*?<\/label>/)?.[0]).not.toContain("button");
  });
  it("associates generated labels with native and custom controls", () => {
    for (const component of [Input, Select, Textarea, "input"] as const) {
      const html = renderToStaticMarkup(
        createElement(Field, {
          label: "Value",
          children: createElement(component as typeof Input),
        }),
      );
      const id = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
      expect(id).toBeTruthy();
      expect(html).toContain(`id="${id}"`);
    }
  });
});
