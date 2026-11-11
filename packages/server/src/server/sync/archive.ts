import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/**
 * The sealed file myna's sync leaves on a WebDAV folder, bucket or repository
 * (see `internal/backup`): one part of the setup as a JSON pack, encrypted
 * with a passphrase so the server only holds bytes it cannot read.
 */

const MAGIC = Buffer.from("NEOLIXSYNC1", "utf8");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** 2^15 × 8 × 128 ≈ 32 MiB; the default maxmem is just under it. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface SyncPackFile {
  /** The whole file's SHA-256, even for one piece of it. */
  sha256: string;
  /** The file's permission bits, as it should be written back. */
  mode: number;
  /** The file's bytes, or one piece's bytes, base64. */
  data: string;
  /** Set when a file too large for one pack is sent in pieces. */
  chunk?: { path: string; index: number; count: number };
}

export interface SyncPack {
  version: 1;
  /** sources, settings, models, library. */
  part: string;
  /** The computer the pack was taken on. */
  device: string;
  takenAt: string;
  /** RelPath → contents, for a pack split over several files. */
  index: number;
  count: number;
  files: Record<string, SyncPackFile>;
}

export interface PartFileInput {
  path: string;
  content: Buffer | string;
  mode?: number;
}

/** One part as packs: a library too large for one file is split by whole files. */
export function buildPacks(input: {
  part: string;
  device: string;
  takenAt?: string;
  files: readonly PartFileInput[];
  /** The most files one pack may hold, uncompressed and base64 aside. */
  maxPartBytes?: number;
}): SyncPack[] {
  const packs: SyncPack[] = [];
  const maxBytes = input.maxPartBytes ?? 8 * 1024 * 1024;
  let current: Record<string, SyncPackFile> = {};
  let bytes = 0;
  const flush = () => {
    if (Object.keys(current).length === 0) {
      return;
    }
    packs.push({
      version: 1,
      part: input.part,
      device: input.device,
      takenAt: input.takenAt ?? new Date().toISOString(),
      index: packs.length,
      count: 0,
      files: current,
    });
    current = {};
    bytes = 0;
  };
  for (const file of input.files) {
    const buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mode = file.mode ?? 0o644;
    if (buffer.byteLength > maxBytes) {
      // A file bigger than one pack is sent in pieces, each its own pack
      // entry; `unpackPacks` puts it back together across packs.
      const count = Math.ceil(buffer.byteLength / maxBytes);
      for (let index = 0; index < count; index += 1) {
        const piece = buffer.subarray(index * maxBytes, (index + 1) * maxBytes);
        if (bytes + piece.byteLength > maxBytes) {
          flush();
        }
        current[`${file.path}#neolix-chunk-${index}`] = {
          sha256,
          mode,
          data: piece.toString("base64"),
          chunk: { path: file.path, index, count },
        };
        bytes += piece.byteLength;
      }
      continue;
    }
    if (bytes + buffer.byteLength > maxBytes) {
      flush();
    }
    current[file.path] = {
      sha256,
      mode,
      data: buffer.toString("base64"),
    };
    bytes += buffer.byteLength;
  }
  flush();
  for (const pack of packs) {
    pack.count = packs.length;
  }
  return packs;
}

/** The pack's files back as bytes, with the hash checked before handing them out. */
export function unpackFiles(pack: SyncPack): { path: string; content: Buffer; mode: number }[] {
  return assemble(Object.entries(pack.files));
}

/** One part's packs back as files, joining a file sent in pieces. */
export function unpackPacks(packs: readonly SyncPack[]): {
  path: string;
  content: Buffer;
  mode: number;
}[] {
  return assemble(packs.flatMap((pack) => Object.entries(pack.files)));
}

function assemble(
  entries: readonly (readonly [string, SyncPackFile])[],
): { path: string; content: Buffer; mode: number }[] {
  const order: string[] = [];
  const pieces = new Map<
    string,
    { files: Map<number, SyncPackFile>; count: number; mode: number }
  >();
  const plain: { path: string; content: Buffer; mode: number }[] = [];
  for (const [key, file] of entries) {
    if (!file.chunk) {
      const content = Buffer.from(file.data, "base64");
      if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
        throw new Error(`${key} does not match its SHA-256`);
      }
      plain.push({ path: key, content, mode: file.mode });
      continue;
    }
    const path = file.chunk.path;
    let group = pieces.get(path);
    if (!group) {
      group = { files: new Map(), count: file.chunk.count, mode: file.mode };
      pieces.set(path, group);
      order.push(path);
    }
    if (group.count !== file.chunk.count) {
      throw new Error(`${path} was sent in a different number of pieces`);
    }
    group.files.set(file.chunk.index, file);
  }
  const joined: { path: string; content: Buffer; mode: number }[] = [];
  for (const path of order) {
    const group = pieces.get(path)!;
    if (group.files.size !== group.count) {
      throw new Error(`${path} is missing part of itself`);
    }
    const content = Buffer.concat(
      [...group.files.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, file]) => Buffer.from(file.data, "base64")),
    );
    const sha = group.files.get(0)!.sha256;
    if (createHash("sha256").update(content).digest("hex") !== sha) {
      throw new Error(`${path} does not match its SHA-256`);
    }
    joined.push({ path, content, mode: group.mode });
  }
  return [...plain, ...joined];
}

/**
 * The bytes as sealed bytes: magic, salt, iv, tag, ciphertext. Packs use it,
 * and so do the usage files, which are not packs but the same envelope.
 */
export function sealData(plain: Buffer, passphrase: string): Buffer {
  if (passphrase.length === 0) {
    throw new Error("A passphrase is required to sync");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

/** The bytes inside sealed bytes; a wrong passphrase or a changed byte throws. */
export function openData(sealed: Buffer, passphrase: string): Buffer {
  if (sealed.byteLength < MAGIC.byteLength + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error("The sync file is truncated");
  }
  if (!sealed.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error("Not a Neox sync file");
  }
  let offset = MAGIC.byteLength;
  const salt = sealed.subarray(offset, (offset += SALT_BYTES));
  const iv = sealed.subarray(offset, (offset += IV_BYTES));
  const tag = sealed.subarray(offset, (offset += TAG_BYTES));
  const ciphertext = sealed.subarray(offset);
  const key = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** The pack as sealed bytes. */
export function sealPack(pack: SyncPack, passphrase: string): Buffer {
  return sealData(Buffer.from(JSON.stringify(pack), "utf8"), passphrase);
}

/** The pack inside sealed bytes; a wrong passphrase or a changed byte throws. */
export function openPack(sealed: Buffer, passphrase: string): SyncPack {
  return JSON.parse(openData(sealed, passphrase).toString("utf8")) as SyncPack;
}

/** The name a part's file takes on the remote, and the ones it was split into. */
export function packFileName(pack: SyncPack): string {
  return `${pack.part}.${String(pack.index).padStart(3, "0")}.neolixsync`;
}
