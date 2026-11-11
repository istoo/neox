import { readFile } from "node:fs/promises";

/**
 * AstrLink Guard's tokenizer, ported from myna's
 * `internal/pii/guard/tokenizer.go` (xlm-roberta's SentencePiece Unigram
 * tokenizer as Hugging Face's tokenizers library runs it). Offsets are
 * UTF-16 indices into the text the tokenizer was given, not bytes: JS
 * strings slice in UTF-16 code units.
 */
export interface GuardToken {
  id: number;
  start: number;
  end: number;
}

/** A character of the normalized text and the text it came from. */
interface NormalizedChar {
  r: string;
  start: number;
  end: number;
}

interface SpecialToken {
  text: string;
  id: number;
  lstrip: boolean;
}

interface TokenizerFile {
  added_tokens?: Array<{
    id: number;
    content: string;
    special?: boolean;
    lstrip?: boolean;
  }>;
  normalizer?: {
    type?: string;
    normalizers?: Array<{ type?: string; precompiled_charsmap?: string }>;
    precompiled_charsmap?: string;
  };
  model?: {
    type?: string;
    unk_id?: number;
    vocab?: Array<[string, number]>;
  };
}

const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The tokenizer as the model's tokenizer.json defines it. */
export class GuardTokenizer {
  private readonly pieces = new Map<string, number>();
  private readonly scores: number[];
  private readonly unk: number;
  private readonly unkCost: number;
  private readonly special: SpecialToken[] = [];
  private readonly trie: Uint32Array;
  private readonly norm: Buffer;
  private readonly maxLenBytes: number;

  private constructor(
    vocab: Array<[string, number]>,
    scores: number[],
    unk: number,
    special: SpecialToken[],
    trie: Uint32Array,
    norm: Buffer,
  ) {
    let maxLen = 0;
    let least = 0;
    for (let index = 0; index < vocab.length; index += 1) {
      const piece = vocab[index]?.[0] ?? "";
      if (!this.pieces.has(piece)) {
        this.pieces.set(piece, index);
      }
      maxLen = Math.max(maxLen, Buffer.byteLength(piece, "utf8"));
      least = Math.min(least, scores[index] ?? 0);
    }
    this.scores = scores;
    this.unk = unk;
    this.unkCost = least - 10;
    this.special = special;
    this.trie = trie;
    this.norm = norm;
    this.maxLenBytes = maxLen;
  }

  static async load(path: string): Promise<GuardTokenizer> {
    return GuardTokenizer.fromJSON(await readFile(path, "utf8"));
  }

  /** Loads a tokenizer.json already in memory (tests). */
  // eslint-disable-next-line complexity -- one validation per field myna reads; splitting it hides the protocol.
  static fromJSON(body: string): GuardTokenizer {
    const file = JSON.parse(body) as TokenizerFile;
    const model = file.model;
    if (model?.type !== "Unigram" || !Array.isArray(model.vocab)) {
      throw new Error(`Not a Unigram tokenizer: ${String(model?.type)}`);
    }
    const vocab = model.vocab;
    const scores = Array.from({ length: vocab.length }, () => 0);
    for (let index = 0; index < vocab.length; index += 1) {
      const entry = vocab[index];
      if (entry === undefined) {
        throw new Error("Unigram vocab is not dense");
      }
      scores[index] = entry[1];
    }
    const special: SpecialToken[] = [];
    for (const token of file.added_tokens ?? []) {
      if (token.special === true) {
        special.push({ text: token.content, id: token.id, lstrip: token.lstrip === true });
      }
    }
    const normalizer = file.normalizer;
    let charmap = normalizer?.precompiled_charsmap;
    if (normalizer?.type === "Sequence" && normalizer.normalizers?.length === 1) {
      charmap = normalizer.normalizers[0]?.precompiled_charsmap;
    }
    if (typeof charmap !== "string") {
      throw new Error("The tokenizer has no precompiled charsmap");
    }
    const raw = Buffer.from(charmap, "base64");
    if (raw.length < 4) {
      throw new Error("Bad precompiled charsmap");
    }
    const size = raw.readUInt32LE(0);
    if (size % 4 !== 0 || 4 + size > raw.length) {
      throw new Error("Bad precompiled charsmap");
    }
    const trie = new Uint32Array(size / 4);
    for (let index = 0; index < trie.length; index += 1) {
      trie[index] = raw.readUInt32LE(4 + 4 * index);
    }
    return new GuardTokenizer(
      vocab,
      scores,
      model.unk_id ?? 0,
      special,
      trie,
      raw.subarray(4 + size),
    );
  }

  /** The text's tokens, without <s> and </s>. */
  encode(text: string): GuardToken[] {
    const out: GuardToken[] = [];
    let at = 0;
    while (at < text.length) {
      const next = this.nextSpecial(text, at);
      const stop = next.start < 0 ? text.length : next.start;
      this.encodePlain(out, text.slice(at, stop), at);
      if (next.id >= 0) {
        out.push({ id: next.id, start: next.start, end: next.end });
      }
      at = next.end;
    }
    return out;
  }

  /** The first special token at or after `at`, the longest there. */
  private nextSpecial(text: string, at: number): { start: number; end: number; id: number } {
    let best = -1;
    let end = -1;
    let id = -1;
    for (const token of this.special) {
      const found = text.indexOf(token.text, at);
      if (found < 0) {
        continue;
      }
      let start = found;
      if (token.lstrip) {
        while (start > at) {
          const before = text.slice(0, start);
          const last = Array.from(before).at(-1) ?? "";
          if (last === "" || !/\s/u.test(last)) {
            break;
          }
          start -= last.length;
        }
      }
      const stop = found + token.text.length;
      if (best < 0 || start < best || (start === best && stop > end)) {
        best = start;
        end = stop;
        id = token.id;
      }
    }
    return { start: best, end: best < 0 ? text.length : end, id };
  }

  private encodePlain(out: GuardToken[], text: string, base: number): void {
    if (text === "") {
      return;
    }
    for (const piece of pretokenize(this.normalize(text, base))) {
      const chars = piece.map((char) => ({
        r: char.r === " " ? "▁" : char.r,
        start: char.start,
        end: char.end,
      }));
      if (chars[0]?.r !== "▁") {
        const first = chars[0];
        if (first !== undefined) {
          chars.unshift({ r: "▁", start: first.start, end: first.end });
        }
      }
      let wordStart = 0;
      for (let index = 1; index <= chars.length; index += 1) {
        if (index === chars.length || chars[index]?.r === "▁") {
          this.unigram(out, chars.slice(wordStart, index));
          wordStart = index;
        }
      }
    }
  }

  /** SentencePiece's precompiled normalization, as the tokenizers library does it. */
  private normalize(text: string, base: number): NormalizedChar[] {
    const out: NormalizedChar[] = [];
    const add = (part: string, at: number, to: string): void => {
      const original: Array<[number, number]> = [];
      let offset = 0;
      for (const char of part) {
        const width = char.length;
        original.push([base + at + offset, base + at + offset + width]);
        offset += width;
      }
      let index = 0;
      for (const char of to) {
        const span = original[Math.min(index, original.length - 1)];
        if (span === undefined) {
          return;
        }
        out.push({ r: char, start: span[0], end: span[1] });
        index += 1;
      }
    };
    for (const segment of SEGMENTER.segment(text)) {
      const grapheme = segment.segment;
      if (Buffer.byteLength(grapheme, "utf8") < 6) {
        const mapped = this.transform(grapheme);
        if (mapped !== null) {
          add(grapheme, segment.index, mapped);
          continue;
        }
      }
      let offset = 0;
      for (const char of grapheme) {
        const part = char;
        const mapped = this.transform(part);
        if (mapped !== null) {
          add(part, segment.index + offset, mapped);
        } else {
          const start = base + segment.index + offset;
          out.push({ r: char, start, end: start + part.length });
        }
        offset += part.length;
      }
    }
    return out;
  }

  /** What the charsmap maps the shortest key at the start of `text` to. */
  private transform(text: string): string | null {
    const unit = (index: number): number | null =>
      index >= 0 && index < this.trie.length ? (this.trie[index] ?? 0) : null;
    const offset = (value: number): number => ((value >>> 10) << ((value & (1 << 9)) >> 6)) >>> 0;
    let position = 0;
    let value = unit(position);
    if (value === null) {
      return null;
    }
    position = (position ^ offset(value)) >>> 0;
    const bytes = Buffer.from(text, "utf8");
    for (const byte of bytes) {
      if (byte === 0) {
        break;
      }
      position = (position ^ byte) >>> 0;
      value = unit(position);
      if (value === null || (value & 0x800000ff) >>> 0 !== byte) {
        return null;
      }
      position = (position ^ offset(value)) >>> 0;
      if (((value >>> 8) & 1) === 1) {
        const target = unit(position);
        if (target === null) {
          return null;
        }
        const start = target & ((1 << 31) - 1);
        if (start > this.norm.length) {
          return null;
        }
        let end = start;
        while (end < this.norm.length && this.norm[end] !== 0) {
          end += 1;
        }
        return this.norm.subarray(start, end).toString("utf8");
      }
    }
    return null;
  }

  /** The Viterbi best split of a word, a run no piece has as one <unk>. */
  // eslint-disable-next-line complexity -- myna's Viterbi loop, one branch per node state, kept beside the port.
  private unigram(out: GuardToken[], word: NormalizedChar[]): void {
    if (word.length === 0) {
      return;
    }
    let text = "";
    const at: number[] = [];
    const bytes: number[] = [];
    let byteCount = 0;
    for (const char of word) {
      at.push(text.length);
      bytes.push(byteCount);
      text += char.r;
      byteCount += Buffer.byteLength(char.r, "utf8");
    }
    at.push(text.length);
    bytes.push(byteCount);
    const charAt = new Map<number, number>();
    for (let index = 0; index < at.length; index += 1) {
      charAt.set(at[index] ?? 0, index);
    }
    const best = Array.from({ length: text.length + 1 }, () => ({
      score: 0,
      from: 0,
      id: 0,
      set: false,
    }));
    const start = best[0];
    if (start !== undefined) {
      start.set = true;
    }
    for (let charIndex = 0; charIndex < word.length; charIndex += 1) {
      const from = at[charIndex] ?? 0;
      const fromNode = best[from];
      if (fromNode === undefined || !fromNode.set) {
        continue;
      }
      const base = fromNode.score;
      let single = false;
      const singleBytes = (bytes[charIndex + 1] ?? 0) - (bytes[charIndex] ?? 0);
      for (let endIndex = charIndex + 1; endIndex <= word.length; endIndex += 1) {
        const byteWidth = (bytes[endIndex] ?? 0) - (bytes[charIndex] ?? 0);
        if (byteWidth > this.maxLenBytes) {
          break;
        }
        const to = at[endIndex] ?? 0;
        const id = this.pieces.get(text.slice(from, to));
        if (id === undefined) {
          continue;
        }
        const score = base + (this.scores[id] ?? 0);
        const node = best[to];
        if (node !== undefined && (!node.set || score > node.score)) {
          node.score = score;
          node.from = from;
          node.id = id;
          node.set = true;
        }
        if (byteWidth === singleBytes) {
          single = true;
        }
      }
      if (!single) {
        const to = from + (at[charIndex + 1] ?? 0) - (at[charIndex] ?? 0);
        const score = base + this.unkCost;
        const node = best[to];
        if (node !== undefined && (!node.set || score > node.score)) {
          node.score = score;
          node.from = from;
          node.id = this.unk;
          node.set = true;
        }
      }
    }
    const reversed: GuardToken[] = [];
    for (let to = text.length; to > 0; ) {
      const node = best[to];
      if (node === undefined || !node.set) {
        break;
      }
      const fromChar = charAt.get(node.from) ?? 0;
      const toChar = charAt.get(to) ?? 0;
      const first = word[fromChar];
      const last = word[toChar - 1];
      if (first === undefined || last === undefined) {
        break;
      }
      reversed.push({ id: node.id, start: first.start, end: last.end });
      to = node.from;
    }
    for (let index = reversed.length - 1; index >= 0; index -= 1) {
      const token = reversed[index];
      if (token === undefined) {
        continue;
      }
      const previous = out.at(-1);
      if (
        token.id === this.unk &&
        previous !== undefined &&
        previous.id === this.unk &&
        index > 0
      ) {
        previous.end = token.end;
        continue;
      }
      out.push(token);
    }
  }
}

/**
 * Splits at whitespace: a run of it is dropped, unless it follows a digit,
 * when each of its characters is a piece of its own.
 */
function pretokenize(chars: NormalizedChar[]): NormalizedChar[][] {
  const out: NormalizedChar[][] = [];
  let wordStart = -1;
  const flush = (end: number): void => {
    if (wordStart >= 0) {
      out.push(chars.slice(wordStart, end));
      wordStart = -1;
    }
  };
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === undefined) {
      break;
    }
    if (!/\s/u.test(char.r)) {
      if (wordStart < 0) {
        wordStart = index;
      }
      index += 1;
      continue;
    }
    flush(index);
    let end = index;
    while (end < chars.length && /\s/u.test(chars[end]?.r ?? "")) {
      end += 1;
    }
    const previous = chars[index - 1];
    if (previous !== undefined && /[0-9]/.test(previous.r)) {
      for (let at = index; at < end; at += 1) {
        out.push(chars.slice(at, at + 1));
      }
    }
    index = end;
  }
  flush(chars.length);
  return out;
}
