/**
 * Gemini signs the first function call of each step it thinks through, and
 * turns the next request away without the signature back on that call
 * (400 "Function call is missing a thought_signature in functionCall
 * parts"). Its OpenAI-compatible API gives the signature beside the call,
 * in tool_calls[].extra_content.google.thought_signature, and takes it
 * back there; a Chat client knows no such field, but every client sends a
 * call's id back as it was given.
 *
 * So the signature rides in the id the client is given,
 * `<id>__ts<n>__<signature>`, and comes off it on the way back. n is how
 * many characters the signature has in the id: a client that shortens an
 * id often leaves something that still decodes, and only n tells a
 * shortened signature from a whole one (myna's gemini_signature.go).
 *
 * A signature grows with the step's thinking, to several KB, and an id
 * that long broke a client that indexes ids. So a long signature is kept
 * in the gateway's folder (sigstore.ts) and the id carries a short key,
 * `<id>__tsk16__<key>`; a key no longer kept reads as no signature
 * (myna's gemini_sigstore.go).
 */
import { keepSignature, keptSignature } from "./sigstore.js";

const SIG_MARK = "__ts";
const SIG_RAW = "r";
const SIG_KEPT = "k";
const SIG_END = "__";
/** Above this, a signature is kept and the id carries its key. */
const INLINE_MOST = 256;

/** What Gemini documents for a call it didn't sign itself. */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Whether the signature is canonical base64, which rides as its own bytes. */
function canonicalBase64(signature: string): string | null {
  const bytes = Buffer.from(signature, "base64");
  return bytes.toString("base64") === signature ? bytes.toString("base64url") : null;
}

/** A call's id carrying its thought signature, as a client gives it back. */
export function signCallId(id: string, signature: string | undefined): string {
  if (signature === undefined || signature.length === 0) {
    return id;
  }
  if (signature.length > INLINE_MOST) {
    const key = keepSignature(signature);
    if (key !== null) {
      return `${id}${SIG_MARK}${SIG_KEPT}${key.length}${SIG_END}${key}`;
    }
  }
  const canonical = canonicalBase64(signature);
  const encoded = canonical ?? base64Url(signature);
  const kind = canonical === null ? SIG_RAW : "";
  return `${id}${SIG_MARK}${kind}${encoded.length}${SIG_END}${encoded}`;
}

/** An id's tail without the kind letter before its length digits. */
function withoutKind(rest: string, raw: boolean, kept: boolean): string {
  if (raw) {
    return rest.slice(SIG_RAW.length);
  }
  return kept ? rest.slice(SIG_KEPT.length) : rest;
}

/** The call's own id and the signature an id carries; none when it was cut. */
export function unsignCallId(id: string): { id: string; signature: string | null } {
  for (let from = 1; from < id.length; ) {
    const found = id.indexOf(SIG_MARK, from);
    if (found < 0) {
      break;
    }
    from = found + 1;
    const rest = id.slice(found + SIG_MARK.length);
    const raw = rest.startsWith(SIG_RAW);
    const kept = !raw && rest.startsWith(SIG_KEPT);
    const afterKind = withoutKind(rest, raw, kept);
    let digits = 0;
    while (digits < afterKind.length && afterKind[digits] >= "0" && afterKind[digits] <= "9") {
      digits += 1;
    }
    const encoded = afterKind.slice(digits);
    if (!encoded.startsWith(SIG_END)) {
      continue; // not a mark: part of the call's own id
    }
    const body = encoded.slice(SIG_END.length);
    // A kept signature's mark always carries its key's length.
    if (kept && digits === 0) {
      continue;
    }
    // The first mark decides: a signature cut short is none.
    if (digits > 0 && afterKind.slice(0, digits) !== String(body.length)) {
      return { id, signature: null };
    }
    if (body.length === 0) {
      return { id, signature: null };
    }
    if (kept) {
      const signature = keptSignature(body);
      if (signature === null) {
        return { id, signature: null };
      }
      return { id: id.slice(0, found), signature };
    }
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length === 0) {
      return { id, signature: null };
    }
    return {
      id: id.slice(0, found),
      signature: raw ? bytes.toString("utf8") : bytes.toString("base64"),
    };
  }
  return { id, signature: null };
}
