import { defineConfig } from "tsdown";

// Note: the bundled binary requires Bun (uses bun:sqlite, Bun.serve, Bun.stdin).
// We target node22 syntax for compatibility but the runtime is Bun.
// A runtime check in src/bin.ts fails loudly if invoked under plain node.
export default defineConfig({
  entry: ["src/bin.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  dts: false,
  sourcemap: true,
  shims: true,
  deps: {
    alwaysBundle: [
      "@oneshot-gtm/core",
      "@oneshot-gtm/intel",
      "@oneshot-gtm/plays",
      "@oneshot-gtm/doctor",
      "@oneshot-gtm/find",
      "@oneshot-gtm/shared-types",
    ],
    neverBundle: ["@oneshot-agent/sdk", "open", "bun:sqlite"],
  },
  banner: {
    js: "#!/usr/bin/env bun",
  },
});
