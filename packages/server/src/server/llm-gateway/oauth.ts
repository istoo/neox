import { createHash, randomBytes } from "node:crypto";

/**
 * The pieces every vendor sign-in shares: PKCE (`provider/signin.go:335-336`
 * and each vendor's own), a random state, and JWT claim reading.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A PKCE verifier and its S256 challenge, as myna sends them. */
export function pkcePair(): PkcePair {
  const verifier = randomToken(48);
  return { verifier, challenge: s256(verifier) };
}

export function s256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** URL-safe random text; 48 bytes is myna's verifier (`signin.go:335`). */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** This machine's id for OpenAI, `urn:uuid:` and a version 4 UUID. */
export function uuidUrn(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A JWT's claims, without checking its signature (the vendor just minted it). */
export function jwtClaims(token: string | null): Record<string, unknown> | null {
  if (token === null) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A claim's text, following one dotted path (`"a"`, `"b"`); "" when absent. */
export function claimString(claims: Record<string, unknown> | null, ...path: string[]): string {
  let value: unknown = claims;
  for (const key of path) {
    if (!isRecord(value)) {
      return "";
    }
    value = value[key];
  }
  return typeof value === "string" ? value : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The OAuth error code and description a refusal carries. */
export interface OAuthErrorBody {
  code: string;
  message: string;
}

export function oauthErrorOf(body: unknown, status: number): OAuthErrorBody {
  if (!isRecord(body)) {
    return { code: "", message: `sign-in refused (${status})` };
  }
  const code = typeof body.error === "string" ? body.error : "";
  const message = firstText(body.error_description, body.message);
  // OpenAI wraps a refusal in `error: {code, message}`.
  if (isRecord(body.error)) {
    const nestedCode = typeof body.error.code === "string" ? body.error.code : "";
    const nestedMessage = typeof body.error.message === "string" ? body.error.message : "";
    return {
      code: nestedCode !== "" ? nestedCode : code,
      message: nestedMessage !== "" ? nestedMessage : message,
    };
  }
  return { code, message };
}

/** The first of the values that is a non-empty string. */
function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return "";
}
