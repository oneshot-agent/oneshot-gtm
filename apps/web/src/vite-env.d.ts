/// <reference types="vite/client" />

/**
 * Declared rather than left to vite's `VITE_*` index signature, so
 * `import.meta.env.VITE_DEMO` can be written with dot access.
 *
 * That is not a style point. vite's `define` substitutes the dot form and not
 * the bracket form, and only the substituted literal lets rollup fold
 * `IS_DEMO` to a constant — which is what keeps the demo transport, the
 * read-only props and the demo chrome out of the dashboard the product ships.
 */
interface ImportMetaEnv {
  /** "1" in a `--mode demo` build, "0" everywhere else. */
  readonly VITE_DEMO: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
