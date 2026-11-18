import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "@neolix/client/internal/daemon-client";
import { afterEach, expect, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createTestNeolixDaemon } from "../test-utils/neolix-daemon.js";

const PUSH_BYTES = 256 * 1024;
const TOTAL_BYTES = 100 * 1024 * 1024;
const PUSHES = TOTAL_BYTES / PUSH_BYTES;

// One buffer, pushed until the total is out: what a capture loop looks like.
const SERVER_ENTRY = `
import { defineSubscription } from "@neolix/plugin";
import type { PluginServerContext } from "@neolix/plugin/server";
import { z } from "zod";

const stream = defineSubscription({
  name: "stream",
  input: z.object({ pushes: z.number().int(), bytes: z.number().int() }),
  event: z.instanceof(Uint8Array),
});

export default function contribute(server: PluginServerContext) {
  server.handle(stream, async ({ pushes, bytes }, { push, signal }) => {
    const chunk = new Uint8Array(bytes).fill(7);
    for (let sent = 0; sent < pushes && !signal.aborted; sent += 1) await push(chunk);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });
  return () => undefined;
}
`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The throughput number is diagnostic only: wall-clock MB/s on a shared CI runner depends on
// every other test in the run, so it cannot be an assertion. The deterministic invariants below
// are the regression lock this test exists for: exactly one frame per push (no re-encoding or
// fragmentation), every payload a view into the received frame (no per-frame copy), and bounded
// memory (no buffering the whole stream).
test(`a plugin streams ${TOTAL_BYTES / 1024 / 1024} MiB in ${PUSH_BYTES / 1024} KiB pushes without copying or buffering per frame`, async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "neolix-plugin-stream-"));
  roots.push(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "neox-plugin.json"),
    JSON.stringify({
      id: "stream",
      requirements: { neolix: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(path.join(pluginDirectory, "index.server.ts"), SERVER_ENTRY);
  const daemon = await createTestNeolixDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: `clid_plugin_stream_${Date.now()}`,
    appVersion: resolveDaemonVersion(import.meta.url),
  });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);

    let received = 0;
    let frames = 0;
    let copied = 0;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const started = performance.now();
    const subscription = client.observePluginRpc("stream", "stream", {
      pushes: PUSHES,
      bytes: PUSH_BYTES,
    });
    subscription.subscribe({
      snapshot: () => undefined,
      update: () => undefined,
      binary: (payload) => {
        received += payload.byteLength;
        frames += 1;
        // The payload is a view into the frame the socket received, not a copy of it. A frame
        // always starts with its opcode/header, so a zero-copy payload has a non-zero offset in a
        // larger buffer; a copied payload is a fresh, exactly-sized allocation.
        if (payload.byteOffset === 0 || payload.buffer.byteLength === payload.byteLength)
          copied += 1;
        if (frames % 40 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers);
        if (received >= TOTAL_BYTES) finished();
      },
    });
    await done;
    const seconds = (performance.now() - started) / 1000;
    const megabytesPerSecond = TOTAL_BYTES / 1e6 / seconds;
    process.stderr.write(
      `[plugin stream] ${frames} frames, ${(TOTAL_BYTES / 1e6).toFixed(1)} MB in ${(seconds * 1000).toFixed(0)} ms: ${megabytesPerSecond.toFixed(0)} MB/s, peak external buffers +${((peak - baseline) / 1024 / 1024).toFixed(1)} MiB\n`,
    );

    expect(frames).toBe(PUSHES);
    expect(received).toBe(TOTAL_BYTES);
    expect(copied).toBe(0);
    // Memory held while streaming stays bounded by in-flight frames, not by the payload total.
    // GC can lag under a loaded runner, so allow one stream's worth of unreclaimed buffers; a
    // path that buffered every push would hold the full total and still fail.
    expect(peak - baseline).toBeLessThan(TOTAL_BYTES);
    await subscription.release();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 120_000);
