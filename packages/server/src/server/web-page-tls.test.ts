import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebPageServer, newWebPageKey, saveWebPageSettings } from "./web-page.js";

const logger = pino({ level: "silent" });
const servers: WebPageServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.dispose();
  }
});

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "neolix-web-tls-"));
}

async function serveWith(cert: string, key: string): Promise<WebPageServer> {
  const home = await tempDir();
  const dist = await tempDir();
  await saveWebPageSettings(home, {
    mode: "local",
    port: 3991,
    key: newWebPageKey(),
    tlsCert: cert,
    tlsKey: key,
  });
  const server = new WebPageServer({
    neolixHome: home,
    distDir: dist,
    logger,
    daemonAddress: () => null,
  });
  servers.push(server);
  await server.start();
  return server;
}

describe("web page TLS failures", () => {
  it("names the file, and no byte of it, when it is not a certificate", async () => {
    const dir = await tempDir();
    const cert = path.join(dir, "page.pem");
    const key = path.join(dir, "page.key");
    const secret = "THIS-IS-NOT-A-CERTIFICATE-and-looks-like-a-secret";
    await writeFile(cert, `${secret}\n`);
    await writeFile(key, `${secret}\n`);

    const state = (await serveWith(cert, key)).state();
    expect(state.error).toContain(cert);
    expect(state.error).toContain("not a usable PEM");
    expect(state.error).not.toContain(secret);
    expect(state.serving).toBe(false);
  });

  it("names a file it cannot read, and no byte of anything", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "gone.pem");
    const key = path.join(dir, "page.key");
    await writeFile(key, "not a key\n");

    const state = (await serveWith(missing, key)).state();
    expect(state.error).toContain(missing);
    expect(state.error).toContain("could not be read");
    expect(state.error).not.toContain("not a key");
    expect(state.serving).toBe(false);
  });
});
