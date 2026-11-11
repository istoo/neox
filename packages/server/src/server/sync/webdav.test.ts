import { describe, expect, it, vi } from "vitest";
import { WebDavClient, WebDavError, parseMultiStatus } from "./webdav.js";

const TARGET = {
  url: "https://dav.example/files/me/neolix/",
  username: "me",
  password: "secret",
};

function clientWith(responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
  return { client: new WebDavClient(TARGET, fetchMock as unknown as typeof fetch), fetchMock };
}

function call(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe("WebDavClient", () => {
  it("creates the folder with Basic auth", async () => {
    const { client, fetchMock } = clientWith([new Response(null, { status: 405 })]);
    await expect(client.ensureFolder()).resolves.toBeUndefined();
    const { url, init, headers } = call(fetchMock, 0);
    expect(url).toBe("https://dav.example/files/me/neolix");
    expect(init.method).toBe("MKCOL");
    expect(headers.authorization).toBe(`Basic ${Buffer.from("me:secret").toString("base64")}`);
  });

  it("puts bytes, conditionally when asked, and returns the ETag", async () => {
    const { client, fetchMock } = clientWith([
      new Response(null, { status: 201, headers: { etag: '"v2"' } }),
    ]);
    const etag = await client.put("settings.000.neolixsync", Buffer.from("sealed"), {
      ifMatch: '"v1"',
    });
    const { url, init, headers } = call(fetchMock, 0);
    expect(url).toBe("https://dav.example/files/me/neolix/settings.000.neolixsync");
    expect(init.method).toBe("PUT");
    expect(headers["if-match"]).toBe('"v1"');
    expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe("sealed");
    expect(etag).toBe('"v2"');
  });

  it("reads a file, and says null when the server has none", async () => {
    const { client } = clientWith([
      new Response("sealed", { status: 200, headers: { etag: '"v2"' } }),
      new Response(null, { status: 404 }),
    ]);
    await expect(client.get("settings.000.neolixsync")).resolves.toEqual({
      body: Buffer.from("sealed"),
      etag: '"v2"',
    });
    await expect(client.get("gone.neolixsync")).resolves.toBeNull();
  });

  it("lists a folder from a PROPFIND answer, leaving the folder itself out", async () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/files/me/neolix/</d:href><d:propstat><d:prop>
          <d:resourcetype><d:collection/></d:resourcetype>
        </d:prop></d:propstat></d:response>
        <d:response><d:href>/files/me/neolix/settings.000.neolixsync</d:href><d:propstat><d:prop>
          <d:getetag>"v2"</d:getetag><d:getlastmodified>Mon, 05 Jan 2026 10:00:00 GMT</d:getlastmodified>
          <d:resourcetype/>
        </d:prop></d:propstat></d:response>
        <D:response><D:href>/files/me/neolix/lib/</D:href><D:propstat><D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
        </D:prop></D:propstat></D:response>
      </d:multistatus>`;
    const { client, fetchMock } = clientWith([
      new Response(xml, { status: 207, headers: { "content-type": "application/xml" } }),
    ]);
    const entries = await client.list();
    const { init, headers } = call(fetchMock, 0);
    expect(init.method).toBe("PROPFIND");
    expect(headers.depth).toBe("1");
    expect(entries).toEqual([
      {
        name: "settings.000.neolixsync",
        etag: '"v2"',
        lastModified: "Mon, 05 Jan 2026 10:00:00 GMT",
        isDirectory: false,
      },
      { name: "lib", etag: null, lastModified: null, isDirectory: true },
    ]);
  });

  it("deletes, and treats a missing file as already gone", async () => {
    const { client } = clientWith([
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
    ]);
    await expect(client.delete("a.neolixsync")).resolves.toBeUndefined();
    await expect(client.delete("a.neolixsync")).resolves.toBeUndefined();
  });

  it("raises the server's status on a failed write", async () => {
    const { client } = clientWith([new Response("nope", { status: 403 })]);
    await expect(client.put("a", Buffer.from("x"))).rejects.toBeInstanceOf(WebDavError);
  });
});

describe("parseMultiStatus", () => {
  it("decodes percent-encoded names", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response>
      <d:href>/neolix/lib%20one.000.neolixsync</d:href><d:propstat><d:prop><d:resourcetype/>
      </d:prop></d:propstat></d:response></d:multistatus>`;
    expect(parseMultiStatus(xml, "https://dav.example/neolix")[0]?.name).toBe(
      "lib one.000.neolixsync",
    );
  });
});
