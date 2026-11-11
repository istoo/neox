import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { Masker, MaskingUnavailableError } from "../llm-gateway/masking.js";
import {
  GUARD_FILES,
  GUARD_REVISION_DIR,
  GUARD_TOTAL_SIZE,
  guardDirectory,
  guardInstalled,
} from "./guard-download.js";
import {
  GUARD_FLOOR,
  GUARD_LABEL_KINDS,
  GuardModel,
  decode,
  marginOf,
  softmaxMax,
  windowStarts,
  type GuardSpan,
} from "./guard-model.js";
import { GuardTokenizer } from "./guard-tokenizer.js";
import {
  GuardNotInstalledError,
  GuardService,
  GuardUnavailableError,
  guardRetryAfter,
} from "./service.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-guard-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

/** An empty SentencePiece charsmap: nothing normalizes, every byte stays. */
function emptyCharsmap(): string {
  return Buffer.alloc(4).toString("base64");
}

function testTokenizer(): GuardTokenizer {
  const vocab: Array<[string, number]> = [
    ["<unk>", 0],
    ["<s>", 0],
    ["</s>", 0],
    ["▁hello", -1],
    ["▁world", -1],
    ["▁你好", -1],
    ["▁", -5],
    ["hello", -8],
    ["world", -8],
    ["你", -10],
    ["好", -10],
    ["ab", -1],
    ["cd", -1],
    ["ef", -1],
    ["gh", -1],
    ["ij", -1],
  ];
  return GuardTokenizer.fromJSON(
    JSON.stringify({
      added_tokens: [
        { id: 1, content: "<s>", special: true },
        { id: 2, content: "</s>", special: true },
        { id: 0, content: "<unk>", special: true },
      ],
      normalizer: { type: "Precompiled", precompiled_charsmap: emptyCharsmap() },
      model: { type: "Unigram", unk_id: 0, vocab },
    }),
  );
}

describe("guard tokenizer", () => {
  test("splits English at whitespace with UTF-16 offsets", () => {
    const tokens = testTokenizer().encode("hello world");
    expect(tokens.map((token) => token.id)).toEqual([3, 4]);
    expect(tokens.map((token) => [token.start, token.end])).toEqual([
      [0, 5],
      [6, 11],
    ]);
    const text = "hello world";
    expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual(["hello", "world"]);
  });

  test("keeps Chinese characters together", () => {
    const tokens = testTokenizer().encode("你好");
    expect(tokens).toEqual([{ id: 5, start: 0, end: 2 }]);
  });

  test("offsets are in code units after Chinese, not bytes", () => {
    const text = "你好 hello";
    const tokens = testTokenizer().encode(text);
    expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual(["你好", "hello"]);
    expect(tokens.map((token) => token.start)).toEqual([0, 3]);
  });

  test("a word no piece covers is split into the pieces it has", () => {
    const text = "abcdefghij";
    const tokens = testTokenizer().encode(text);
    // The first token is the metaspace marker, as SentencePiece gives it;
    // it shares the first character's span (myna does the same).
    expect(tokens.map((token) => token.id)).toEqual([6, 11, 12, 13, 14, 15]);
    expect(tokens.slice(1).map((token) => text.slice(token.start, token.end))).toEqual([
      "ab",
      "cd",
      "ef",
      "gh",
      "ij",
    ]);
    expect(tokens.at(-1)?.end).toBe(text.length);
  });

  test("a special token is its own token, the text around it plain", () => {
    const tokens = testTokenizer().encode("hello<s>world");
    expect(tokens.map((token) => token.id)).toEqual([3, 1, 4]);
    expect(tokens[1]).toEqual({ id: 1, start: 5, end: 8 });
  });
});

describe("guard model helpers", () => {
  test("softmax's best probability is the label's", () => {
    const result = softmaxMax([0, Math.log(3)]);
    expect(result.label).toBe(1);
    expect(result.probability).toBeCloseTo(0.75, 10);
    expect(softmaxMax([2, 2])).toEqual({ label: 0, probability: 0.5 });
  });

  test("windows overlap by 128 tokens, the last one carrying the tail", () => {
    expect(windowStarts(10)).toEqual([0]);
    expect(windowStarts(510)).toEqual([0]);
    expect(windowStarts(511)).toEqual([0, 382]);
    expect(windowStarts(1000)).toEqual([0, 382, 764]);
  });

  test("a token is labelled by the window it is furthest inside", () => {
    expect(marginOf(500, 0, 510)).toBe(9);
    expect(marginOf(500, 382, 892)).toBe(118);
    expect(marginOf(636, 382, 892)).toBe(254);
  });

  test("BIO tags decode into spans scored by their least token", () => {
    const tokens = [
      { id: 1, start: 0, end: 3 },
      { id: 2, start: 4, end: 8 },
      { id: 3, start: 9, end: 10 },
    ];
    const spans = decode(tokens, [19, 20, 0], [0.9, 0.6, 0.99]);
    expect(spans).toEqual([{ start: 0, end: 8, label: "private_person", score: 0.6 }]);
  });

  test("an I tag of another kind starts a new span, O ends it", () => {
    const tokens = [
      { id: 1, start: 0, end: 3 },
      { id: 2, start: 3, end: 6 },
      { id: 3, start: 7, end: 9 },
    ];
    const spans = decode(tokens, [19, 3, 1], [0.9, 0.9, 0.9]);
    expect(spans).toEqual([
      { start: 0, end: 3, label: "private_person", score: 0.9 },
      { start: 3, end: 6, label: "phone", score: 0.9 },
      { start: 7, end: 9, label: "email", score: 0.9 },
    ]);
  });

  test("spans under the floor are dropped, and no-text tokens skipped", () => {
    const tokens = [
      { id: 1, start: 0, end: 0 },
      { id: 2, start: 1, end: 4 },
    ];
    expect(decode(tokens, [19, 19], [0.99, GUARD_FLOOR - 0.01])).toEqual([]);
  });
});

describe("guard service", () => {
  test("status says the model is not downloaded, and its size", async () => {
    const home = await temporaryHome();
    const service = new GuardService({ neolixHome: home, logger });
    const status = await service.status();
    expect(status).toMatchObject({
      model: "astrlink-guard",
      installed: false,
      size: GUARD_TOTAL_SIZE,
      downloading: false,
      running: false,
      score: 0.8,
    });
    await expect(service.find(["hi"])).rejects.toBeInstanceOf(GuardNotInstalledError);
  });

  test("retry after doubles from 30s to 10 minutes", () => {
    expect(guardRetryAfter(1)).toBe(30_000);
    expect(guardRetryAfter(2)).toBe(60_000);
    expect(guardRetryAfter(5)).toBe(480_000);
    expect(guardRetryAfter(20)).toBe(600_000);
  });

  test("a load failure holds the next request back at once", async () => {
    const home = await temporaryHome();
    const dir = guardDirectory(home);
    await mkdir(dir, { recursive: true });
    for (const file of GUARD_FILES) {
      const target = path.join(dir, path.basename(file.path));
      await writeFile(target, "");
      await truncate(target, file.size);
    }
    expect(await guardInstalled(home)).toBe(true);
    const service = new GuardService({ neolixHome: home, logger });
    await expect(service.find(["hello"])).rejects.toBeInstanceOf(GuardUnavailableError);
    const status = await service.status();
    expect(status.failed).toBeDefined();
    await expect(service.find(["hello"])).rejects.toThrow(/tried again/);
  });

  test("remove deletes the model's folder", async () => {
    const home = await temporaryHome();
    const dir = guardDirectory(home);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "model_int8.onnx"), "");
    const service = new GuardService({ neolixHome: home, logger });
    await service.remove();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("masking with the local model", () => {
  function maskerWith(
    model: {
      installed: () => Promise<boolean>;
      find: (texts: readonly string[]) => Promise<GuardSpan[][]>;
    },
    score: () => number | undefined,
  ): Masker {
    return new Masker({
      neolixHome: path.join(tmpdir(), "unused-masker-home"),
      logger,
      allow: () => [],
      personal: () => true,
      secrets: () => true,
      localModel: () => ({
        installed: model.installed,
        find: async (texts) =>
          (await model.find(texts)).map((spans) =>
            spans.map((span) => ({
              start: span.start,
              end: span.end,
              label: span.label,
              kind: GUARD_LABEL_KINDS[span.label] ?? "SECRET",
              score: span.score,
            })),
          ),
      }),
      localModelScore: score,
    });
  }

  function findsFor(text: string, at: number, length: number, score: number): GuardSpan[][] {
    return [text].map(() => [{ start: at, end: at + length, label: "private_person", score }]);
  }

  test("finds over the threshold are masked as the model's", async () => {
    const person = "Zebulon Quux";
    const text = `call ${person} now`;
    const masker = maskerWith(
      { installed: async () => true, find: async () => findsFor(text, 5, person.length, 0.85) },
      () => undefined,
    );
    await masker.ensureKey();
    await masker.prime(text);
    const masked = masker.maskTextWithHits(text);
    expect(masked.hits).toHaveLength(1);
    expect(masked.hits[0]).toMatchObject({ kind: "PERSON", by: "model", length: person.length });
    expect(masked.text).not.toContain(person);
  });

  test("a find under the user's threshold stays as written", async () => {
    const person = "Zebulon Quux";
    const text = `call ${person} now`;
    let threshold: number | undefined;
    const masker = maskerWith(
      { installed: async () => true, find: async () => findsFor(text, 5, person.length, 0.75) },
      () => threshold,
    );
    await masker.ensureKey();
    await masker.prime(text);
    expect(masker.maskTextWithHits(text).hits).toHaveLength(0);
    threshold = 0.7;
    expect(masker.maskTextWithHits(text).hits).toHaveLength(1);
  });

  test("a rule's kind wins where both find the same value", async () => {
    const value = "AKIAABCDEFGHIJKLMNOP";
    const text = `key ${value}`;
    const masker = maskerWith(
      { installed: async () => true, find: async () => findsFor(text, 4, value.length, 0.95) },
      () => undefined,
    );
    await masker.ensureKey();
    await masker.prime(text);
    const masked = masker.maskTextWithHits(text);
    expect(masked.hits.some((hit) => hit.by === "rule")).toBe(true);
    expect(masked.hits.some((hit) => hit.by === "model")).toBe(false);
  });

  test("a model turned on but not downloaded holds the request back", async () => {
    const phone = "+86 139 0000 0000";
    const text = `call ${phone} now`;
    const masker = maskerWith(
      { installed: async () => false, find: async () => findsFor(text, 5, phone.length, 0.99) },
      () => undefined,
    );
    await masker.ensureKey();
    await expect(masker.prime(text)).rejects.toThrow(/isn't downloaded/);
  });

  test("a model that fails holds the request back", async () => {
    const masker = maskerWith(
      {
        installed: async () => true,
        find: async () => {
          throw new Error("the model is broken");
        },
      },
      () => undefined,
    );
    await expect(masker.prime("hello there")).rejects.toBeInstanceOf(MaskingUnavailableError);
  });
});

/** Real inference runs only when a cache path is given; tests never download. */
const realDir = process.env.NEOLIX_GUARD_MODEL_DIR;
const realTest =
  realDir !== undefined && existsSync(path.join(realDir, "model_int8.onnx")) ? test : test.skip;

describe("real inference", () => {
  realTest(
    "loads the pinned model and finds a phone number",
    async () => {
      if (realDir === undefined) {
        return;
      }
      const model = await GuardModel.load(realDir);
      try {
        const spans = await model.find("张三的电话是 +86 139 0000 0000");
        expect(spans.some((span) => span.label === "phone")).toBe(true);
      } finally {
        await model.close();
      }
    },
    120_000,
  );
});

test("the pinned revision folder is its first twelve characters", () => {
  expect(GUARD_REVISION_DIR).toBe("7216b6a3b897");
});
