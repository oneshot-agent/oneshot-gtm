import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { NOSCRIPT_HTML, transformDemoHead } from "./vite-plugins/demo-head.ts";

/**
 * `--mode demo` builds the vendored copy that oneshot-gtm.com serves at /demo.
 *
 * It differs from the real dashboard in three ways and no others: the base
 * path, the transport (see src/api/demo.ts) and the head, which a static file
 * has to carry itself because there is no server rendering one for it.
 *
 * The output goes to dist-demo, never dist. `demo ui` and `oneshot-gtm ui`
 * serve dist, and a demo bundle landing there would point a real install's
 * dashboard at fixtures — a real ledger showing invented rows.
 */
export default defineConfig(({ mode }) => {
  const isDemo = mode === "demo";

  return {
    ...(isDemo ? { base: "/demo/" } : {}),

    resolve: {
      alias: isDemo
        ? [
            {
              find: /\/StrategistDock\.tsx$/,
              replacement: "/StrategistDock.demo.tsx",
            },
          ]
        : [],
    },

    plugins: [
      TanStackRouterVite({
        target: "react",
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
      ...(isDemo ? [demoHead()] : []),
    ],

    define: {
      "import.meta.env.VITE_DEMO": JSON.stringify(isDemo ? "1" : "0"),
    },

    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          // The CLI sets ONESHOT_GTM_API_PORT to the workspace's server port —
          // a hardcoded 3030 would silently proxy a named workspace's dev UI to
          // the DEFAULT workspace's API (wrong ledger, lying workspace badge).
          target: `http://127.0.0.1:${process.env["ONESHOT_GTM_API_PORT"] ?? "3030"}`,
          changeOrigin: true,
        },
      },
    },

    build: {
      outDir: isDemo ? "dist-demo" : "dist",
      // No prod source maps — they added ~2.5 MB to dist/ and exposed source.
      sourcemap: false,
    },
  };
});

/**
 * Vite wrapper around apps/web/vite-plugins/demo-head.ts.
 *
 * The head block is swapped by marker, and the noscript block goes in through
 * vite's tags API — so nothing here anchors on a literal <title> or
 * <div id="root"></div> that a casual edit to index.html would silently break.
 */
function demoHead(): Plugin {
  return {
    name: "oneshot-gtm-demo-head",
    transformIndexHtml(html) {
      return {
        html: transformDemoHead(html),
        // The demo is a client-rendered app, so with scripting off there is
        // nothing to render and nothing to fix. Say so, and point back at the
        // page, which needs no JavaScript to be read.
        tags: [{ tag: "noscript", children: NOSCRIPT_HTML, injectTo: "body" }],
      };
    },
  };
}
