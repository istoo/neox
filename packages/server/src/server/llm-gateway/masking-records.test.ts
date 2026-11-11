import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { MaskingRecordStore } from "./masking-records.js";
import type { MaskHit } from "./masking.js";

const logger = pino({ level: "silent" });

const hits: MaskHit[] = [
  { placeholder: "{{API_KEY_abc}}", kind: "API_KEY", by: "builtin", head: "sk-", length: 20 },
];

function storeAt(neolixHome: string): MaskingRecordStore {
  return new MaskingRecordStore({ neolixHome, logger });
}

describe("MaskingRecordStore's call id", () => {
  it("keeps the call id and filters records by it", async () => {
    const store = storeAt(mkdtempSync(path.join(tmpdir(), "neolix-masking-")));
    await store.start();

    store.add({ gatewayCallId: "call-1", hits, blocked: false });
    store.add({ gatewayCallId: "call-2", hits, blocked: false });

    const first = store.list({ gatewayCallId: "call-1" });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.gatewayCallId).toBe("call-1");
    expect(store.list({}).records).toHaveLength(2);
  });

  it("keeps records written without a call id", async () => {
    const store = storeAt(mkdtempSync(path.join(tmpdir(), "neolix-masking-")));
    await store.start();

    const record = store.add({ hits, blocked: false });

    expect(record?.gatewayCallId).toBeUndefined();
    expect(store.list({}).records).toHaveLength(1);
  });
});
