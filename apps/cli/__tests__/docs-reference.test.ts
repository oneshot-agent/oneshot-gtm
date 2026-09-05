import { Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { mdxText, referenceMatches, renderCliReference } from "../src/docs-reference.ts";

const revision = "a".repeat(40);
describe("CLI documentation", () => {
  it("renders nested arguments, inherited flags, choices, defaults and MDX safely without actions", () => {
    let invoked = false;
    const root = new Command("gtm").option("-w, --workspace <name>", "workspace");
    root
      .command("find")
      .command("drain <play> [files...]")
      .description("Pass <input> | {value} & `code`")
      .requiredOption("--target <file>", "target")
      .option("--no-browser", "Disable browser")
      .addOption(
        new Option("--order <mode>", "Order").choices(["ranked", "newest"]).default("newest"),
      )
      .action(() => {
        invoked = true;
      });
    const text = renderCliReference(root, revision);
    expect(text).toContain("## gtm find drain");
    expect(text).toContain("| play | Yes |");
    expect(text).toContain("| files... | No |");
    expect(text).toContain("--workspace &#60;name&#62;");
    expect(text).toContain("Pass &#60;input&#62; &#124; &#123;value&#125; &#38; &#96;code&#96;");
    expect(text).toContain("| --target &#60;file&#62; | target | — | Yes |");
    expect(text).toContain("true (enabled)");
    expect(text).toContain('Choices: ranked, newest. | "newest"');
    expect(invoked).toBe(false);
    expect(renderCliReference(root, revision)).toBe(text);
    expect(referenceMatches(text, text.replace(revision, "b".repeat(40)))).toBe(true);
    expect(referenceMatches(text, text.replace("Disable browser", "Changed"))).toBe(false);
  });

  it("covers every command and flag in the live tree", async () => {
    process.env["ONESHOT_GTM_CLI_NO_PARSE"] = "1";
    const { program } = await import("../src/index.ts");
    const text = renderCliReference(program, revision);
    function check(cmd: Command, parent = "") {
      const path = parent ? `${parent} ${cmd.name()}` : cmd.name();
      expect(text).toContain(`## ${path}\n`);
      for (const option of cmd.options) {
        if (!option.hidden) expect(text).toContain(mdxText(option.flags));
      }
      for (const child of cmd.commands) check(child, path);
    }
    check(program);
  });
});
