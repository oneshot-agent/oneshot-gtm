import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

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
 * The head for the vendored build.
 *
 * index.html is the only thing a crawler or a link unfurler ever sees at
 * /demo, since everything below it is rendered client side. `noindex` is
 * deliberate: the demo has no crawlable content and would otherwise compete
 * with the pages that do.
 */
function demoHead(): Plugin {
  const TITLE = "The dashboard, clickable — oneshot-gtm";
  const DESCRIPTION =
    "Click through the real oneshot-gtm dashboard over a seeded ledger: signed receipts, CAC per play, and the gates that refuse to scale a broken motion.";

  return {
    name: "oneshot-gtm-demo-head",
    transformIndexHtml(html) {
      return html
        .replace(
          '<div id="root"></div>',
          // The demo is a client-rendered app, so with scripting off there is
          // nothing to render and nothing to fix. Say so, and point back at
          // the page, which needs no JavaScript to be read.
          [
            '<div id="root"></div>',
            "<noscript>",
            '  <div style="font-family:system-ui,sans-serif;color:#e8e3d9;background:#14120f;',
            "              min-height:100vh;display:flex;flex-direction:column;justify-content:center;",
            '              gap:16px;padding:32px;max-width:44rem;margin:0 auto">',
            '    <h1 style="font-size:1.6rem;margin:0">The demo needs JavaScript.</h1>',
            '    <p style="margin:0;line-height:1.55;color:#b9b2a5">',
            "      It is the dashboard itself, rendered in the browser. The page that explains it reads",
            "      fine without scripting.",
            "    </p>",
            '    <p style="margin:0"><a href="https://oneshot-gtm.com" style="color:#e8e3d9">',
            "      Back to oneshot-gtm.com</a></p>",
            '    <p style="margin:0;font-family:ui-monospace,monospace;color:#b9b2a5">',
            "      Or run it yourself: bunx oneshot-gtm-server</p>",
            "  </div>",
            "</noscript>",
          ].join("\n    "),
        )
        .replace(
          "<title>oneshot-gtm</title>",
          [
            `<title>${TITLE}</title>`,
            // The site's own mark. Without it the browser asks the origin for
            // /favicon.ico, which oneshot-gtm.com does not serve.
            `<link rel="icon" href="/icon.svg" type="image/svg+xml" />`,
            `<meta name="description" content="${DESCRIPTION}" />`,
            `<meta name="robots" content="noindex" />`,
            `<meta property="og:type" content="website" />`,
            `<meta property="og:title" content="${TITLE}" />`,
            `<meta property="og:description" content="${DESCRIPTION}" />`,
            `<meta property="og:url" content="https://oneshot-gtm.com/demo" />`,
            `<meta name="twitter:card" content="summary_large_image" />`,
          ].join("\n    "),
        );
    },
  };
}
