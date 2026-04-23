import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/__tests__/**/*.test.ts", "apps/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
  resolve: {
    alias: [
      {
        find: /^@oneshot-gtm\/core$/,
        replacement: path.resolve(import.meta.dirname, "./packages/core/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/intel$/,
        replacement: path.resolve(import.meta.dirname, "./packages/intel/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/plays$/,
        replacement: path.resolve(import.meta.dirname, "./packages/plays/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/doctor$/,
        replacement: path.resolve(import.meta.dirname, "./packages/doctor/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/find$/,
        replacement: path.resolve(import.meta.dirname, "./packages/find/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/ledger$/,
        replacement: path.resolve(import.meta.dirname, "./packages/ledger/src/index.ts"),
      },
      {
        find: /^@oneshot-gtm\/shared-types$/,
        replacement: path.resolve(import.meta.dirname, "./packages/shared-types/src/index.ts"),
      },
    ],
  },
});
