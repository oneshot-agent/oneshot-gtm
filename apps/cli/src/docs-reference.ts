import type { Command } from "commander";
import { homedir } from "node:os";

/** Escape plain help text, including JSX/expression syntax and table delimiters. */
export function mdxText(value: string): string {
  return value
    .split(/(https?:\/\/[^\s]+)/g)
    .map((part) => {
      // CLI examples such as localhost:<port> are literal syntax, not live links.
      if (/^https?:\/\//.test(part))
        return "`" + part.replaceAll("`", "").replaceAll("|", "\\|") + "`";
      return part
        .replace(/[&<>{}|`*_[\]\\]/g, (char) => `&#${char.charCodeAt(0)};`)
        .replace(/\r?\n/g, "<br />");
    })
    .join("");
}

export function renderCliReference(program: Command, revision: string): string {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a full Git commit SHA");
  const lines = [
    "---",
    'title: "CLI reference"',
    'description: "Commands, arguments, and options generated from the OneShot GTM CLI."',
    "---",
    "",
    `{/* Generated from oneshot-agent/oneshot-gtm at ${revision}. Do not edit by hand. */}`,
    "",
    "Run these commands with `bun run cli --` from the GTM checkout, or with `oneshot-gtm` after linking the CLI. The CLI is not published to npm.",
    "",
    "Options below come from Commander. Runtime-dependent defaults are described in the help text. Use `--help` on any command for local help.",
    "",
  ];
  function visit(cmd: Command, ancestors: Command[]) {
    const path = [...ancestors, cmd].map((c) => c.name()).join(" ");
    lines.push(`## ${mdxText(path)}`, "", mdxText(cmd.description()), "");
    if (cmd.aliases().length) lines.push(`Aliases: ${cmd.aliases().map(mdxText).join(", ")}`, "");
    if (cmd.registeredArguments.length) {
      lines.push(
        "### Arguments",
        "",
        "| Argument | Required | Description | Default |",
        "| --- | --- | --- | --- |",
      );
      for (const arg of cmd.registeredArguments) {
        lines.push(
          `| ${mdxText(arg.name() + (arg.variadic ? "..." : ""))} | ${arg.required ? "Yes" : "No"} | ${mdxText(arg.description)} | ${mdxText(arg.defaultValue === undefined ? "—" : JSON.stringify(arg.defaultValue))} |`,
        );
      }
      lines.push("");
    }
    const seen = new Set<string>();
    const options = [...ancestors, cmd]
      .toReversed()
      .flatMap((owner) => owner.options.map((option) => ({ owner, option })))
      .filter(({ option }) => {
        if (option.hidden || seen.has(option.attributeName())) return false;
        seen.add(option.attributeName());
        return true;
      });
    if (options.length) {
      lines.push(
        "### Options",
        "",
        "| Flag | Description | Default | Required | Defined on |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const { owner, option } of options) {
        const description =
          option.description +
          (option.argChoices ? ` Choices: ${option.argChoices.join(", ")}.` : "");
        const fallback =
          option.defaultValue === undefined
            ? option.negate
              ? "true (enabled)"
              : "—"
            : JSON.stringify(option.defaultValue).replaceAll(homedir(), "~");
        lines.push(
          `| ${mdxText(option.flags)} | ${mdxText(description)} | ${mdxText(option.defaultValueDescription ?? fallback)} | ${option.mandatory ? "Yes" : "No"} | ${mdxText(owner.name())} |`,
        );
      }
      lines.push("");
    }
    for (const child of cmd.commands) visit(child, [...ancestors, cmd]);
  }
  visit(program, []);
  return lines.join("\n") + "\n";
}

/** Ignore provenance only: unrelated source commits must not make content stale. */
export function referenceMatches(actual: string, expected: string): boolean {
  return normalizeReference(actual) === normalizeReference(expected);
}

function normalizeReference(text: string): string {
  return text.replace(/at [a-f0-9]{40}\. Do not edit by hand\./, "at SOURCE. Do not edit by hand.");
}
