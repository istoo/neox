import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  readArchivedCall,
  readPromptText,
  readRouteEvents,
  readRoutingHistory,
} from "./gateway-diagnostics.js";
import { GatewayArchive } from "./gateway-archive.js";
import { clearPromptBodies, keepPromptBody } from "./prompt-text.js";
import { clearRouteEvents, publishRoute } from "./route-events.js";
import { RouteHistory } from "./route-history.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  clearPromptBodies();
  clearRouteEvents();
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "neolix-diagnostics-"));
  homes.push(dir);
  return dir;
}

function route(
  id: string,
  time: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, time, status: 200, done: true, asked: "gpt-5", ...extra };
}

describe("routing history reads", () => {
  it("returns the days kept and the latest day's routes when no day is named", async () => {
    const history = new RouteHistory({ neolixHome: await home(), logger });
    await history.start();
    history.record(route("req_1", "2026-11-05T10:00:00.000Z"));
    history.record(route("req_2", "2026-11-05T11:00:00.000Z", { responseId: "resp_2" }));
    await history.dispose();

    const read = await readRoutingHistory(history, "");
    expect(read.days).toEqual(["2026-11-05"]);
    expect(read.day).toBe("2026-11-05");
    expect(read.routes.map((entry) => entry.id)).toEqual(["req_1", "req_2"]);
    expect(read.routes[1]?.responseId).toBe("resp_2");
  });

  it("drops a line that is not a route", async () => {
    const dir = await home();
    await mkdir(path.join(dir, "gateway-routing"), { recursive: true });
    await writeFile(
      path.join(dir, "gateway-routing", "2026-11-05.jsonl"),
      `${JSON.stringify(route("req_1", "2026-11-05T10:00:00.000Z"))}\n{"not":"a route"}\n`,
    );
    const history = new RouteHistory({ neolixHome: dir, logger });

    const read = await readRoutingHistory(history, "2026-11-05");
    expect(read.routes.map((entry) => entry.id)).toEqual(["req_1"]);
  });

  it("answers an empty list when no history exists", async () => {
    const history = new RouteHistory({ neolixHome: await home(), logger });
    const read = await readRoutingHistory(history, "");
    expect(read).toEqual({ days: [], day: "", routes: [] });
  });
});

describe("archive reads", () => {
  it("reads a kept call and refuses a name that could leave the folder", async () => {
    const dir = await home();
    await mkdir(path.join(dir, "request-archive", "2026-11-05"), { recursive: true });
    await writeFile(
      path.join(dir, "request-archive", "2026-11-05", "100000-ab.json"),
      JSON.stringify({
        id: "2026-11-05/100000-ab",
        time: "2026-11-05T10:00:00.000Z",
        request: { method: "POST", path: "/v1/responses", headers: {}, body: "{}" },
        response: { status: 200, headers: {}, body: "{}" },
      }),
    );
    const archive = new GatewayArchive({ neolixHome: dir, logger });

    const call = await readArchivedCall(archive, "2026-11-05", "100000-ab");
    expect(call?.request.path).toBe("/v1/responses");
    expect(await readArchivedCall(archive, "2026-11-05", "../../etc/passwd")).toBeNull();
    expect(await readArchivedCall(archive, "../x", "100000-ab")).toBeNull();
  });
});

describe("prompt text reads", () => {
  it("returns the kept body, then null once it has left memory", () => {
    keepPromptBody("req_1", "openai-responses", { model: "gpt-5", input: "hi" });
    expect(readPromptText("req_1")).toEqual({
      id: "req_1",
      protocol: "openai-responses",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
    });
    expect(readPromptText("req_2")).toBeNull();
    clearPromptBodies();
    expect(readPromptText("req_1")).toBeNull();
  });
});

describe("route events reads", () => {
  it("resumes from the cursor a reader kept", () => {
    publishRoute(route("req_1", "2026-11-05T10:00:00.000Z"));
    publishRoute(route("req_2", "2026-11-05T10:01:00.000Z"));
    publishRoute(route("req_3", "2026-11-05T10:02:00.000Z"));

    const all = readRouteEvents(0);
    expect(all.cursor).toBe(3);
    expect(all.routes.map((entry) => entry.route.id)).toEqual(["req_1", "req_2", "req_3"]);

    const resumed = readRouteEvents(2);
    expect(resumed.routes).toEqual([
      { cursor: 3, route: expect.objectContaining({ id: "req_3" }) },
    ]);
    expect(readRouteEvents(3)).toEqual({ cursor: 3, routes: [] });
  });
});
