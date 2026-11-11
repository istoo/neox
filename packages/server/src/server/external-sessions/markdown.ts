import type { ExternalSession } from "./types.js";
import type { TranscriptPart } from "./transcript.js";

export interface SessionMarkdown {
  fileName: string;
  markdown: string;
}

/** A session's whole conversation as Markdown, in myna's shape. */
export function renderSessionMarkdown(input: {
  session: ExternalSession;
  agentName: string;
  parts: readonly TranscriptPart[];
  cut: boolean;
}): SessionMarkdown {
  const { session } = input;
  const lines: string[] = [];
  const title = session.title.trim().length > 0 ? session.title : "(no prompt)";
  lines.push(`# ${oneLine(title)}`, "");
  meta(lines, "Agent", input.agentName);
  meta(lines, "Session ID", `\`${session.id}\``);
  meta(lines, "Folder", session.cwd);
  meta(lines, "Started", when(session.start));
  meta(lines, "Last active", when(session.last));
  meta(lines, "Models", session.models.map((model) => model.model).join(", "));
  if (session.gateway === true) {
    meta(lines, "Recorded by", "Neox's gateway");
  } else {
    meta(lines, "File", session.path);
  }
  if (input.cut) {
    lines.push("", "*Not all of this session was kept: what follows is what is left of it.*");
  }
  lines.push("", "---");
  let who = "";
  let said = false;
  for (const part of input.parts) {
    const text = part.text.trim();
    if (text.length === 0) {
      continue;
    }
    said = true;
    if (part.role !== "tool" && part.role !== who) {
      who = part.role;
      lines.push("", `## ${part.role === "assistant" ? "Assistant" : "User"}`);
    }
    lines.push("");
    if (part.kind === "thinking") {
      folded(lines, "Thinking", text, false);
    } else if (part.kind === "tool_use") {
      lines.push(`**Tool call: ${oneLine(part.name ?? "tool")}**`, "");
      fenced(lines, isJsonText(text) ? "json" : "", text);
    } else if (part.kind === "tool_result") {
      folded(
        lines,
        `Tool result${part.name === undefined ? "" : `: ${oneLine(part.name)}`}`,
        text,
        true,
      );
    } else if (part.kind === "context") {
      folded(lines, "Context", text, true);
    } else if (part.kind === "image") {
      lines.push("*[image]*");
    } else {
      lines.push(text);
    }
    if (part.cut !== undefined && part.cut > 0) {
      lines.push("", `*… ${part.cut} more characters weren't kept.*`);
    }
  }
  if (!said) {
    lines.push("", "*Nothing was said in this session.*");
  }
  lines.push("");
  const short = [...session.id].slice(0, 12).join("");
  return {
    fileName: `neolix-session-${safeName(session.agent)}-${safeName(short)}.md`,
    markdown: lines.join("\n"),
  };
}

function meta(lines: string[], key: string, value: string): void {
  if (value.length > 0) {
    lines.push(`- **${key}:** ${value}`);
  }
}

function when(iso: string): string {
  if (iso.length === 0) {
    return "";
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function folded(lines: string[], summary: string, text: string, code: boolean): void {
  lines.push("<details>", `<summary>${htmlEscape(summary)}</summary>`, "");
  if (code) {
    fenced(lines, "", text);
  } else {
    lines.push(text);
  }
  lines.push("", "</details>");
}

function fenced(lines: string[], language: string, text: string): void {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    if (character === "`") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  lines.push(`${fence}${language}`, text, fence);
}

function isJsonText(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function oneLine(value: string): string {
  return value.split(/\s+/u).filter(Boolean).join(" ");
}

function htmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-");
}
