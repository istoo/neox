/* eslint-disable complexity -- the fake API server is one switch over a handful of routes. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { GitHubRemote, S3Remote, RemoteConflictError, signAwsRequest } from "./remote.js";
import type { SyncConfig } from "./config.js";

const CONFIG: SyncConfig = {
  enabled: true,
  url: "github://owner/repo/neolix",
  password: "ghp_test-token",
  passphrase: "passphrase",
  keys: false,
  parts: { sources: true, settings: true, profiles: true, models: true, library: true },
  intervalMinutes: 3,
};

interface FakeFile {
  body: Buffer;
  sha: string;
}

function fakeGitHub() {
  const files = new Map<string, FakeFile>();
  const blobs = new Map<string, Buffer>();
  const commitTrees = new Map<string, string>();
  let head: string | null = null;
  let counter = 0;
  const calls: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
  const sha = (prefix: string) => `${prefix}${(counter += 1)}`;
  const commit = (tree: string): string => {
    const id = sha("commit");
    commitTrees.set(id, tree);
    head = id;
    return id;
  };
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const api = decodeURIComponent(url.pathname);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: api,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body,
    });
    if (api === "/repos/owner/repo") {
      return Response.json({ default_branch: "main", private: true });
    }
    if (api === "/repos/owner/repo/git/ref/heads/main") {
      if (method === "PATCH") {
        head = body.sha;
        return Response.json({ object: { sha: head } });
      }
      if (!head) {
        return new Response(JSON.stringify({ message: "Git Repository is empty." }), {
          status: 409,
        });
      }
      return Response.json({ object: { sha: head } });
    }
    if (api.startsWith("/repos/owner/repo/git/blobs/")) {
      const blob = blobs.get(api.split("/").at(-1)!);
      return blob ? new Response(blob) : new Response("missing", { status: 404 });
    }
    if (api === "/repos/owner/repo/git/blobs" && method === "POST") {
      const content = Buffer.from(body.content, "base64");
      const id = sha("blob");
      blobs.set(id, content);
      return Response.json({ sha: id });
    }
    if (api.startsWith("/repos/owner/repo/git/commits/") && method === "GET") {
      const tree = commitTrees.get(api.split("/").at(-1)!);
      return tree
        ? Response.json({ tree: { sha: tree } })
        : new Response("missing", { status: 404 });
    }
    if (api === "/repos/owner/repo/git/commits" && method === "POST") {
      return Response.json({ sha: commit(body.tree) });
    }
    if (api === "/repos/owner/repo/git/trees" && method === "POST") {
      for (const entry of body.tree) {
        if (entry.sha === null) {
          files.delete(entry.path);
        } else {
          const content = blobs.get(entry.sha);
          if (!content) {
            return new Response("missing blob", { status: 422 });
          }
          files.set(entry.path, { body: content, sha: entry.sha });
        }
      }
      return Response.json({ sha: sha("tree") });
    }
    if (api.startsWith("/repos/owner/repo/contents")) {
      const path = api.slice("/repos/owner/repo/contents".length).replace(/^\//, "");
      const ref = url.searchParams.get("ref");
      if (method === "GET" && !ref) {
        return Response.json(
          [...files.entries()]
            .filter(([name]) => name.startsWith(`${path}/`))
            .map(([name, file]) => ({
              name: name.slice(path.length + 1),
              sha: file.sha,
              type: "file",
            })),
        );
      }
      if (method === "GET") {
        const file = files.get(path);
        if (!file) {
          return new Response("not found", { status: 404 });
        }
        const small = file.body.byteLength <= 1024 * 1024;
        return Response.json({
          type: "file",
          sha: file.sha,
          size: file.body.byteLength,
          encoding: small ? "base64" : "none",
          content: small ? file.body.toString("base64") : "",
        });
      }
      if (method === "PUT") {
        if (head && !path.endsWith("README.md")) {
          return new Response("exists", { status: 422 });
        }
        const content = Buffer.from(body.content, "base64");
        const id = sha("blob");
        blobs.set(id, content);
        files.set(path, { body: content, sha: id });
        const tree = sha("tree");
        commit(tree);
        return Response.json({ content: { sha: id } });
      }
    }
    return new Response("bad", { status: 400 });
  };
  return { files, blobs, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("GitHubRemote", () => {
  it("creates, lists, reads, updates and deletes through the Contents API", async () => {
    const github = fakeGitHub();
    const remote = new GitHubRemote(CONFIG, github.fetchImpl);
    const created = await remote.put("sources.000.neolixsync", Buffer.from("one"), null);
    expect(created.etag).toBe("blob1");
    expect(github.calls[0]?.auth).toBe("Bearer ghp_test-token");
    expect(await remote.list()).toEqual([{ name: "sources.000.neolixsync", etag: "blob1" }]);
    expect((await remote.get("sources.000.neolixsync"))?.data.toString()).toBe("one");

    const updated = await remote.put("sources.000.neolixsync", Buffer.from("two"), "blob1");
    expect(updated.etag).toBe("blob4");
    await expect(
      remote.put("sources.000.neolixsync", Buffer.from("three"), "blob1"),
    ).rejects.toBeInstanceOf(RemoteConflictError);

    await remote.delete("sources.000.neolixsync");
    expect(await remote.list()).toEqual([]);
  });

  it("refuses to create a file that is already there", async () => {
    const github = fakeGitHub();
    const remote = new GitHubRemote(CONFIG, github.fetchImpl);
    await remote.put("a.neolixsync", Buffer.from("1"), null);
    await expect(remote.put("a.neolixsync", Buffer.from("2"), null)).rejects.toBeInstanceOf(
      RemoteConflictError,
    );
  });

  it("writes a file larger than the Contents API carries, and reads its blob", async () => {
    const github = fakeGitHub();
    const remote = new GitHubRemote(CONFIG, github.fetchImpl);
    await remote.put("first.neolixsync", Buffer.from("init"), null);
    const big = Buffer.alloc(1_200_000, 7);
    const written = await remote.put("big.neolixsync", big, null);
    expect(written.etag).toBeTruthy();
    const read = await remote.get("big.neolixsync");
    expect(read?.data.equals(big)).toBe(true);
  });
});

class FakeS3 {
  private readonly files = new Map<string, Buffer>();
  private readonly server: Server;
  base = "";
  lastAuth: string | undefined;

  constructor(private readonly bucket: string) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("no address");
    }
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.lastAuth = request.headers.authorization;
    const url = new URL(request.url ?? "/", this.base);
    const key = decodeURIComponent(url.pathname.replace(`/${this.bucket}/`, ""));
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...this.files.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => `<Contents><Key>${name}</Key></Contents>`)
        .join("");
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<ListBucketResult>${keys}</ListBucketResult>`);
      return;
    }
    if (request.method === "GET") {
      const body = this.files.get(key);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { etag: '"e1"' }).end(body);
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.headers["if-none-match"] === "*" && this.files.has(key)) {
        response.writeHead(412).end();
        return;
      }
      this.files.set(key, Buffer.concat(chunks));
      response.writeHead(200, { etag: '"e1"' }).end();
      return;
    }
    if (request.method === "DELETE") {
      this.files.delete(key);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(405).end();
  }
}

describe("S3Remote", () => {
  const buckets: FakeS3[] = [];
  afterEach(async () => {
    await Promise.all(buckets.splice(0).map((bucket) => bucket.stop()));
  });

  it("signs requests with SigV4 and reads, writes and lists path-style objects", async () => {
    const bucket = new FakeS3("bucket");
    buckets.push(bucket);
    await bucket.start();
    const remote = new S3Remote(
      {
        ...CONFIG,
        url: "s3://bucket/neolix",
        user: "AKIDEXAMPLE",
        password: "secret",
        endpoint: bucket.base,
        region: "us-east-1",
        pathStyle: true,
      },
      fetch,
    );
    await remote.ensure();
    const written = await remote.put("sources.000.neolixsync", Buffer.from("sealed"), null);
    expect(written.etag).toBe("e1");
    expect(bucket.lastAuth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=.+, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
    expect(bucket.lastAuth).toContain("aws4_request");
    expect(await remote.list()).toEqual([{ name: "sources.000.neolixsync", etag: null }]);
    expect((await remote.get("sources.000.neolixsync"))?.data.toString()).toBe("sealed");
    await remote.delete("sources.000.neolixsync");
    expect(await remote.get("sources.000.neolixsync")).toBeNull();
  });
});

describe("SigV4 (AWS official test vectors)", () => {
  const credentials = {
    accessKey: "AKIDEXAMPLE/20261105/us-east-1/s3/aws4_request",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
    host: "example.amazonaws.com",
    contentSha256: false,
  };

  it("signs get-vanilla as the suite does", () => {
    const headers = signAwsRequest({
      ...credentials,
      method: "GET",
      path: "/",
      body: Buffer.alloc(0),
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/20150830/us-east-1/service/aws4_request, ` +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sorts the query keys of get-vanilla-query-order-key-case", () => {
    const headers = signAwsRequest({
      ...credentials,
      method: "GET",
      path: "/",
      query: new URLSearchParams("Param2=value2&Param1=value1"),
      body: Buffer.alloc(0),
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/20150830/us-east-1/service/aws4_request, ` +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });
});
