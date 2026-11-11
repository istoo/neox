import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openData } from "./archive.js";
import {
  dropOtherUsage,
  readMergedQuotas,
  readOtherQuotaReadings,
  readOwnSharedDays,
  shareUsage,
  sharedKept,
  usageDevice,
  usageReport,
  type SharedUsageDay,
  type UsageRemoteFiles,
  type UsageSyncState,
} from "./usage.js";

const PASSPHRASE = "correct horse battery staple";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-usage-"));
  homes.push(dir);
  return dir;
}

/** The server's `usage/` folder in memory, a version a write. */
class MemoryFiles implements UsageRemoteFiles {
  readonly bodies = new Map<string, Buffer>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  private readonly versions = new Map<string, string>();
  private count = 0;

  async list(): Promise<Map<string, string>> {
    return new Map([...this.bodies.keys()].map((name) => [name, this.versions.get(name) ?? ""]));
  }

  async read(name: string): Promise<Buffer> {
    this.reads.push(name);
    const body = this.bodies.get(name);
    if (!body) {
      throw new Error(`no ${name}`);
    }
    return body;
  }

  async write(name: string, data: Buffer): Promise<void> {
    this.count += 1;
    this.bodies.set(name, data);
    this.versions.set(name, `v${this.count}`);
    this.writes.push(name);
  }

  async remove(name: string): Promise<void> {
    this.bodies.delete(name);
    this.versions.delete(name);
  }
}

const NOON = new Date(2026, 0, 2, 12).getTime();

function localDay(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

const DAY = localDay(NOON);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: new Date(NOON).toISOString(),
    requested: "m1",
    provider: "lab",
    account: null,
    model: "m1",
    protocol: "anthropic",
    status: 200,
    ok: true,
    inputTokens: 10,
    outputTokens: 5,
    attempts: 1,
    durationMs: 10,
    costUsd: 0.1,
    priced: true,
    key: null,
    ...overrides,
  };
}

async function writeRecords(dir: string, records: readonly Record<string, unknown>[]) {
  await writeFile(
    path.join(dir, "gateway-usage.jsonl"),
    `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

function quota(at: number, account = "one") {
  return {
    at,
    provider: "lab",
    account,
    remaining: 10,
    limit: 100,
    resetAt: null,
    usedPercent: 0.9,
  };
}

async function share(
  dir: string,
  files: MemoryFiles,
  device: { id: string; name: string },
  state: UsageSyncState,
  now = NOON,
) {
  await shareUsage({
    neolixHome: dir,
    passphrase: PASSPHRASE,
    device,
    state,
    files,
    now,
  });
}

function openSealed(sealed: Buffer): unknown {
  return JSON.parse(openData(sealed, PASSPHRASE).toString("utf8"));
}

describe("shared usage", () => {
  it("makes this computer's days from the ledger, myna's SharedDay fields", async () => {
    const dir = await home();
    await writeRecords(dir, [
      record(),
      record({ status: 500, ok: false, costUsd: 0, priced: false, reasoningTokens: 3 }),
      record({ probe: "test" }),
      record({ time: new Date(2025, 11, 28, 12).toISOString() }),
    ]);
    const day = DAY;
    const days = await readOwnSharedDays(dir, "2025-12-28");
    expect([...days.keys()].sort()).toEqual(["2025-12-28", day].sort());
    const calls = days.get(day) ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      t: new Date(NOON).toISOString(),
      agent: "neolix",
      provider: "lab",
      model: "m1",
      in: 10,
      out: 5,
      cache_read: 0,
      cache_write: 0,
      ms: 10,
      status: 200,
      cost: 0.1,
      priced: true,
    });
    expect(calls[1]).toMatchObject({ status: 500, priced: false, reasoning: 3 });
  });

  it("puts one sealed file a day, and sends nothing again while the day is unchanged", async () => {
    const dir = await home();
    const device = await usageDevice(dir, "A");
    const files = new MemoryFiles();
    const state: UsageSyncState = {};
    await writeRecords(dir, [record()]);

    await share(dir, files, device, state);
    const day = DAY;
    const name = `${device.id}-${day}.neolix-usage`;
    expect([...files.bodies.keys()]).toEqual([name]);
    const sealed = files.bodies.get(name)!;
    expect(sealed.toString("utf8")).not.toContain("lab");
    const shared = openSealed(sealed) as SharedUsageDay;
    expect(shared).toMatchObject({ computer: device.id, name: "A", day });
    expect(shared.calls).toHaveLength(1);

    await share(dir, files, device, state);
    expect(files.writes).toEqual([name]);

    await writeRecords(dir, [record(), record({ time: new Date(NOON + 1000).toISOString() })]);
    await share(dir, files, device, state);
    expect(files.writes).toEqual([name, name]);
  });

  it("brings another computer's day in, and reads it again only at a new version", async () => {
    const dirA = await home();
    const dirB = await home();
    const a = await usageDevice(dirA, "A");
    const b = await usageDevice(dirB, "B");
    const files = new MemoryFiles();
    const stateA: UsageSyncState = {};
    const stateB: UsageSyncState = {};
    await writeRecords(dirA, [record()]);
    await writeRecords(dirB, [record({ costUsd: 0.2 })]);

    await share(dirA, files, a, stateA);
    await share(dirB, files, b, stateB);
    await share(dirA, files, a, stateA);

    const day = DAY;
    expect(await sharedKept(dirA)).toEqual([`${b.id}/${day}`]);
    const reads = files.reads.length;
    await share(dirA, files, a, stateA);
    expect(files.reads).toHaveLength(reads);

    const report = await usageReport(dirA, a, NOON);
    expect(report.devices).toHaveLength(2);
    expect(report.computers?.map((computer) => computer.id).sort()).toEqual(["this", b.id].sort());
    expect(report.computers?.find((computer) => computer.id === b.id)?.name).toBe("B");
    expect(report.rows.find((row) => row.computer === b.id)?.computerName).toBe("B");
    expect(report.series).toHaveLength(90);
    expect(report.series.at(-1)?.label).toBe(day);
    expect(report.series.find((point) => point.label === day)?.calls).toBe(2);
    expect(report.calls).toBe(2);
  });

  it("after the whole window, remakes only yesterday and today", async () => {
    const dir = await home();
    const device = await usageDevice(dir, "A");
    const files = new MemoryFiles();
    const state: UsageSyncState = {};
    const old = new Date(NOON - 5 * 24 * 60 * 60_000).toISOString();
    await writeRecords(dir, [record({ time: old })]);

    await share(dir, files, device, state);
    expect(state.whole).toBe(true);
    expect(files.writes).toHaveLength(1);

    await writeRecords(dir, [record({ time: old }), record({ time: old, costUsd: 0.3 })]);
    await share(dir, files, device, state);
    expect(files.writes).toHaveLength(1);
  });

  it("merges every computer's quota points without sampling", async () => {
    const dirA = await home();
    const dirB = await home();
    const a = await usageDevice(dirA, "A");
    const b = await usageDevice(dirB, "B");
    const files = new MemoryFiles();
    const stateA: UsageSyncState = {};
    const stateB: UsageSyncState = {};
    await writeFile(
      path.join(dirA, "gateway-quota-readings.jsonl"),
      `${Array.from({ length: 400 }, (_, index) => quota(NOON - index * 60_000))
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    await writeFile(
      path.join(dirB, "gateway-quota-readings.jsonl"),
      `${Array.from({ length: 10 }, (_, index) => quota(NOON - 1000 - index * 60_000))
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    await share(dirB, files, b, stateB);
    await share(dirA, files, a, stateA);

    const merged = await readMergedQuotas(dirA, NOON);
    expect(Object.keys(merged)).toEqual(["lab/one"]);
    expect(merged["lab/one"]).toHaveLength(410);
    const ownFile = files.bodies.get(`${a.id}.neolix-quotas`);
    expect(ownFile).toBeDefined();
    const shared = openSealed(ownFile!) as { entries: Record<string, unknown[]> };
    expect(shared.entries["lab/one"]).toHaveLength(410);

    const other = await readOtherQuotaReadings(dirA, 0, {}, NOON);
    expect(other).toHaveLength(10);
    expect(new Set(other.map((entry) => entry.device))).toEqual(new Set([b.id]));
    expect(await readOtherQuotaReadings(dirA, 0, { provider: "none" }, NOON)).toEqual([]);
  });

  it("drops the other computers' days when sharing stops", async () => {
    const dir = await home();
    const device = await usageDevice(dir, "A");
    const files = new MemoryFiles();
    const state: UsageSyncState = {};
    await writeRecords(dir, [record()]);
    await share(dir, files, device, state);
    expect(await sharedKept(dir)).toEqual([]);

    await dropOtherUsage(dir);
    expect(await sharedKept(dir)).toEqual([]);
  });
});
