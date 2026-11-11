import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { GuardTokenizer, type GuardToken } from "./guard-tokenizer.js";

/** The model's BIO tags, by output index (its labels.json). */
export const GUARD_LABELS = [
  "O",
  "B-email",
  "I-email",
  "B-phone",
  "I-phone",
  "B-account",
  "I-account",
  "B-payment_card",
  "I-payment_card",
  "B-ip_address",
  "I-ip_address",
  "B-url",
  "I-url",
  "B-common_secret",
  "I-common_secret",
  "B-private_address",
  "I-private_address",
  "B-private_date",
  "I-private_date",
  "B-private_person",
  "I-private_person",
] as const;

/** The publisher's default threshold (myna's guard.MinScore). */
export const GUARD_MIN_SCORE = 0.8;
/** The lowest score a span may have to be kept (guard.Floor). */
export const GUARD_FLOOR = 0.5;
/** Tokens the model reads at once, besides <s> and </s>. */
export const GUARD_WINDOW = 510;
/** How many tokens neighbouring windows share. */
export const GUARD_OVERLAP = 128;
export const GUARD_CLS_ID = 0;
export const GUARD_EOS_ID = 2;

/** What the model found: `text[start:end]`, its label, and its least token. */
export interface GuardSpan {
  start: number;
  end: number;
  label: string;
  score: number;
}

/** How many reads may run at once: half the cores, never more than four. */
export function guardCores(): number {
  const count = availableParallelism?.() ?? cpus().length;
  return Math.max(1, Math.min(4, Math.floor(count / 2)));
}

/** A process-wide cap on concurrent inference calls. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) {
        next();
      }
    }
  }
}

const inference = new Semaphore(guardCores());

interface LoadedModel {
  tokenizer: GuardTokenizer;
  session: Awaited<ReturnType<typeof loadSession>>;
  outputName: string;
}

async function loadSession(modelPath: string) {
  const ort = await import("onnxruntime-node");
  return ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    // One thread per run: the semaphore already caps concurrent reads at
    // guardCores(), so the model never takes more cores than myna's.
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
}

/** The windows a text of `total` tokens is read in. */
export function windowStarts(total: number): number[] {
  const starts: number[] = [];
  for (let start = 0; ; start += GUARD_WINDOW - GUARD_OVERLAP) {
    starts.push(start);
    if (start + GUARD_WINDOW >= total) {
      break;
    }
  }
  return starts;
}

/** How far inside its window a token is: the window that is furthest wins. */
export function marginOf(index: number, start: number, end: number): number {
  return Math.min(index - start, end - 1 - index);
}

/** A row's best label and its softmax probability, as myna computes them. */
export function softmaxMax(
  row: ArrayLike<number>,
  start = 0,
  count = row.length - start,
): { label: number; probability: number } {
  let best = 0;
  let max = row[start] ?? 0;
  for (let index = 0; index < count; index += 1) {
    const value = row[start + index] ?? 0;
    if (value > max) {
      best = index;
      max = value;
    }
  }
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    sum += Math.exp((row[start + index] ?? 0) - max);
  }
  return { label: best, probability: 1 / sum };
}

/** AstrLink Guard, loaded from its three files. */
export class GuardModel {
  private constructor(private readonly loaded: LoadedModel) {}

  static async load(dir: string): Promise<GuardModel> {
    const tokenizer = await GuardTokenizer.load(path.join(dir, "tokenizer.json"));
    const session = await loadSession(path.join(dir, "model_int8.onnx"));
    const output = session.outputNames[0];
    if (output === undefined) {
      throw new Error("The model has no output");
    }
    const inputs = session.inputNames;
    for (const name of ["input_ids", "attention_mask", "token_type_ids"]) {
      if (!inputs.includes(name)) {
        throw new Error(`The model has no ${name} (it has ${inputs.join(", ") || "no inputs"})`);
      }
    }
    return new GuardModel({ tokenizer, session, outputName: output });
  }

  async find(text: string): Promise<GuardSpan[]> {
    const tokens = this.loaded.tokenizer.encode(text);
    const total = tokens.length;
    if (total === 0) {
      return [];
    }
    const starts = windowStarts(total);
    const logits = await Promise.all(
      starts.map((start) => inference.run(() => this.readWindow(tokens, start))),
    );
    const labels = Array.from({ length: total }, () => 0);
    const probabilities = Array.from({ length: total }, () => 0);
    const margins = Array.from({ length: total }, () => -1);
    const kinds = GUARD_LABELS.length;
    for (let window = 0; window < starts.length; window += 1) {
      const start = starts[window] ?? 0;
      const end = Math.min(start + GUARD_WINDOW, total);
      const output = logits[window];
      if (output === undefined) {
        continue;
      }
      for (let index = 0; index < end - start; index += 1) {
        const position = start + index;
        const margin = marginOf(position, start, end);
        if (margin <= (margins[position] ?? -1)) {
          continue;
        }
        const rowAt = (index + 1) * kinds;
        const best = softmaxMax(output, rowAt, kinds);
        margins[position] = margin;
        labels[position] = best.label;
        probabilities[position] = best.probability;
      }
    }
    return decode(tokens, labels, probabilities);
  }

  private async readWindow(tokens: GuardToken[], start: number): Promise<Float32Array> {
    const end = Math.min(start + GUARD_WINDOW, tokens.length);
    const length = end - start + 2;
    const ids = new BigInt64Array(length);
    const mask = new BigInt64Array(length);
    const types = new BigInt64Array(length);
    ids[0] = BigInt(GUARD_CLS_ID);
    ids[length - 1] = BigInt(GUARD_EOS_ID);
    for (let index = 0; index < length; index += 1) {
      mask[index] = 1n;
    }
    for (let index = start; index < end; index += 1) {
      const token = tokens[index];
      ids[index - start + 1] = BigInt(token?.id ?? 0);
    }
    const ort = await import("onnxruntime-node");
    const shape = [1, length];
    const result = await this.loaded.session.run({
      input_ids: new ort.Tensor("int64", ids, shape),
      attention_mask: new ort.Tensor("int64", mask, shape),
      token_type_ids: new ort.Tensor("int64", types, shape),
    });
    const logits = result[this.loaded.outputName];
    if (logits === undefined) {
      throw new Error(`The model returned no ${this.loaded.outputName}`);
    }
    return logits.data as Float32Array;
  }

  async close(): Promise<void> {
    await this.loaded.session.release();
  }
}

/**
 * Reads BIO tags into spans: a B tag, or an I tag of another kind than the
 * span before it, starts one; an I tag of the same kind extends it; O ends
 * it. A span's score is its least token's, and those under the floor are
 * dropped. Tokens of no text (a lone "▁") neither start nor end a span.
 */
export function decode(
  tokens: readonly GuardToken[],
  labels: readonly number[],
  probabilities: readonly number[],
): GuardSpan[] {
  const spans: GuardSpan[] = [];
  let current = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.start === token.end) {
      continue;
    }
    const tag = GUARD_LABELS[labels[index] ?? 0] ?? "O";
    if (tag === "O") {
      current = -1;
      continue;
    }
    const kind = tag.slice(2);
    const span = spans[current];
    if (tag[0] === "B" || current < 0 || span === undefined || span.label !== kind) {
      spans.push({
        start: token.start,
        end: token.end,
        label: kind,
        score: probabilities[index] ?? 0,
      });
      current = spans.length - 1;
      continue;
    }
    span.end = token.end;
    span.score = Math.min(span.score, probabilities[index] ?? 0);
  }
  return spans.filter((span) => span.score >= GUARD_FLOOR);
}

/** The model's labels as masking kinds; labels not here are left out. */
export const GUARD_LABEL_KINDS: Readonly<Record<string, string>> = {
  private_person: "PERSON",
  private_address: "ADDRESS",
  phone: "PHONE",
  email: "EMAIL",
  account: "ACCOUNT",
  payment_card: "ACCOUNT",
  common_secret: "SECRET",
};
