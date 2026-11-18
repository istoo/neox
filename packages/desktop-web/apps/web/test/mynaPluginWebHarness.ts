// Serves the converted myna fixture page under the same origin and the same sandbox policy the
// bridge applies in production, so the browser test exercises the iframe with real headers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

import { MYNA_BRIDGE_SOURCE } from "../../../../server/src/server/plugins/myna-bridge.ts";
import {
  PLUGIN_WEB_SDK_SESSION_MARKER,
  PLUGIN_WEB_SDK_SOURCE,
} from "../../../packages/plugin-web-sdk/src/bootstrap.ts";

const PLUGIN_ID = "acme-usage-glance";
const PAGE_DIRECTORY = fileURLToPath(
  new URL(
    "../../../../server/src/server/plugins/test-fixtures/myna-page-plugin/page/",
    import.meta.url,
  ),
);

const SDK = PLUGIN_WEB_SDK_SOURCE.replace(
  PLUGIN_WEB_SDK_SESSION_MARKER,
  "document.querySelector('meta[name=\"neolix-session\"]').content",
);

const PROBE = `(async () => {
  await window.myna.ready;
  const options = await window.myna.options.get();
  const summary = await window.myna.read("usage:summary", { period: "today" });
  parent.postMessage({
    __mynaProbe: true,
    calls: summary.calls,
    hideCost: options.hideCost,
    context: window.myna.context,
  }, "*");
})();`;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function serve(
  response: import("node:http").ServerResponse,
  type: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", type);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

function pageHtml(session: string): string {
  return readFileSync(`${PAGE_DIRECTORY}index.html`, "utf8")
    .replace(
      "<head>",
      `<head><meta name="neolix-session" content="${session}"><script src="/plugin-web/${PLUGIN_ID}/__neolix_sdk.js"></script>`,
    )
    .replace("</body>", `<script src="/plugin-web/${PLUGIN_ID}/page/__probe.js"></script></body>`);
}

export function mynaPluginWebHarness(): Plugin {
  return {
    name: "myna-plugin-web-harness",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const prefix = `/plugin-web/${PLUGIN_ID}/`;
        if (!url.pathname.startsWith(prefix)) {
          next();
          return;
        }
        const asset = url.pathname.slice(prefix.length);
        if (asset === "__neolix_sdk.js") {
          serve(response, "text/javascript; charset=utf-8", SDK);
          return;
        }
        if (asset === "page/index.html") {
          const session = url.searchParams.get("neolixSession") ?? "";
          serve(response, "text/html; charset=utf-8", pageHtml(session), {
            "Content-Security-Policy": CSP,
          });
          return;
        }
        if (asset === "page/_owl/bridge.js") {
          serve(response, "text/javascript; charset=utf-8", MYNA_BRIDGE_SOURCE);
          return;
        }
        if (asset === "page/__probe.js") {
          serve(response, "text/javascript; charset=utf-8", PROBE);
          return;
        }
        if (asset === "page/app.js") {
          serve(
            response,
            "text/javascript; charset=utf-8",
            readFileSync(`${PAGE_DIRECTORY}app.js`, "utf8"),
          );
          return;
        }
        if (asset === "page/style.css") {
          serve(
            response,
            "text/css; charset=utf-8",
            readFileSync(`${PAGE_DIRECTORY}style.css`, "utf8"),
          );
          return;
        }
        response.statusCode = 404;
        response.end("Not found");
      });
    },
  };
}
