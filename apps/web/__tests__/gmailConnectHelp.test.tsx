import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GmailConnectHelp } from "../src/components/setup/GmailConnectHelp.tsx";

it.each(["https://gtm.tail1234.ts.net:3030", "https://gtm.example.com"])(
  "shows the exact callback and Web client credentials for %s",
  (origin) => {
    const html = renderToStaticMarkup(<GmailConnectHelp origin={origin} />);
    expect(html).toContain(
      `<code class="break-all select-all">${origin}/api/gmail/auth/callback</code>`,
    );
    expect(html).toContain("Web application");
    expect(html).toContain("client ID and client secret from that same Web client");
    expect(html).toContain("GMAIL_CLIENT_ID");
    expect(html).toContain("GMAIL_CLIENT_SECRET");
    expect(html).toContain("redirect_uri_mismatch");
    expect(html).toContain("return to Setup");
  },
);

it.each(["http://localhost:3030", "http://127.0.0.1:3030", "http://[::1]:3030"])(
  "leaves loopback Setup unchanged at %s",
  (origin) => {
    expect(renderToStaticMarkup(<GmailConnectHelp origin={origin} />)).toBe("");
  },
);
