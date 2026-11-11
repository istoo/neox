export interface SseEvent {
  event: string | null;
  data: string;
}

/** Splits an SSE byte stream into events without assuming chunk boundaries. */
export class SseParser {
  private buffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];

  public push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return events;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, events);
    }
  }

  public flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer.replace(/\r$/, ""), events);
      this.buffer = "";
    }
    this.consumeLine("", events);
    return events;
  }

  private consumeLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        events.push({ event: this.eventName, data: this.dataLines.join("\n") });
      }
      this.eventName = null;
      this.dataLines = [];
      return;
    }
    if (line.startsWith("event:")) {
      this.eventName = line.slice("event:".length).trim();
      return;
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice("data:".length).trimStart());
    }
  }
}

export function formatSseEvent(event: string | null, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const prefix = event === null ? "" : `event: ${event}\n`;
  return `${prefix}data: ${payload}\n\n`;
}
