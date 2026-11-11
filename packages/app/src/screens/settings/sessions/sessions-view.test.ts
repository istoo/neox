import { describe, expect, it } from "vitest";
import type { ExternalSession } from "@neolix/protocol/messages";
import {
  baseName,
  filterSessions,
  GATEWAY_GROUP,
  groupKeyOf,
  groupSessions,
  hiddenProviderSessions,
  isScratchGroup,
  modelsText,
  parentPath,
  subagentTree,
  talkLines,
} from "./sessions-view";

function session(overrides: Partial<ExternalSession>): ExternalSession {
  return {
    id: "session-1",
    agent: "claude",
    cwd: "/work/app",
    title: "Fix the login bug",
    start: "2026-09-20T10:00:00.000Z",
    last: "2026-09-20T10:05:00.000Z",
    messages: 2,
    size: 1024,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    models: [
      {
        model: "claude-opus-5-5",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        priced: false,
      },
    ],
    cost: 0,
    priced: false,
    resume: "",
    path: "",
    deletable: true,
    ...overrides,
  };
}

describe("sessions view", () => {
  it("groups by folder, newest group first, and folds app folders apart", () => {
    const grouped = groupSessions(
      [
        session({ id: "a", cwd: "/work/app", last: "2026-09-20T10:00:00.000Z" }),
        session({ id: "b", cwd: "/work/app", last: "2026-09-20T11:00:00.000Z" }),
        session({ id: "c", cwd: "/tmp/scratch", last: "2026-09-20T09:00:00.000Z" }),
        session({ id: "d", cwd: "", gateway: true, last: "2026-09-20T08:00:00.000Z" }),
      ],
      "/work",
    );

    expect(grouped.projects.map((group) => group.key)).toEqual(["/work/app", GATEWAY_GROUP]);
    expect(grouped.projects[0]?.sessions.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(grouped.projects[0]?.latest.id).toBe("b");
    expect(grouped.projects[0]?.where).toBe("~");
    expect(grouped.others.map((group) => group.key)).toEqual(["/tmp/scratch"]);
  });

  it("filters on titles, folders, ids and models, plus what the search found", () => {
    const sessions = [
      session({ id: "a", title: "Fix the login bug" }),
      session({ id: "b", cwd: "/work/other", title: "Add a README" }),
    ];
    expect(filterSessions(sessions, "login", new Map()).map((entry) => entry.id)).toEqual(["a"]);
    expect(filterSessions(sessions, "other", new Map()).map((entry) => entry.id)).toEqual(["b"]);
    expect(
      filterSessions(
        sessions,
        "needle",
        new Map([
          ["b", { id: "b", role: "user", kind: "text", before: "", match: "needle", after: "" }],
        ]),
      ).map((entry) => entry.id),
    ).toEqual(["b"]);
    expect(filterSessions(sessions, "", new Map())).toHaveLength(2);
  });

  it("says the requested model, then what the gateway served", () => {
    expect(modelsText(session({}))).toBe("claude-opus-5-5");
    expect(
      modelsText(
        session({
          models: [
            {
              model: "claude-opus-5-5",
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              cost: 0,
              priced: false,
            },
          ],
          via: [
            {
              requested: "provider/deepseek-v4.1-flash",
              model: "deepseek-v4.1-flash",
              effort: "high",
            },
            { requested: "provider/other", model: "other" },
          ],
        }),
      ),
    ).toBe("claude-opus-5-5 → deepseek-v4.1-flash · high +1");
  });

  it("names folders and where they are, with the home folder as ~", () => {
    expect(baseName("/work/app/")).toBe("app");
    expect(parentPath("/work/app", "/work")).toBe("~");
    expect(parentPath("/work/app/sub", "/work")).toBe("~/app");
    expect(parentPath("/etc", "/work")).toBe("/");
    expect(groupKeyOf(session({ cwd: "" }))).toBe("");
    expect(groupKeyOf(session({ cwd: "", gateway: true }))).toBe(GATEWAY_GROUP);
    expect(isScratchGroup("/tmp/x")).toBe(true);
    expect(isScratchGroup("/work/app")).toBe(false);
  });

  it("orders subagents as they started one another, indented by depth", () => {
    const tree = subagentTree([
      { id: "b", title: "Second", kind: "Explore", parent: "a" },
      { id: "a", title: "First", kind: "general" },
      { id: "c", title: "Third", kind: "Explore", parent: "b" },
    ]);

    expect(tree.map((node) => [node.sub.id, node.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("shows a subagent whose parent loop never reaches the top", () => {
    const tree = subagentTree([
      { id: "a", title: "A", kind: "general", parent: "b" },
      { id: "b", title: "B", kind: "general", parent: "a" },
    ]);

    expect(tree.map((node) => node.sub.id)).toEqual(["a", "b"]);
  });

  it("finds the Codex sessions its history doesn't list", () => {
    const hidden = hiddenProviderSessions([
      session({ id: "a", agent: "codex", provider: "custom", usesProvider: "neolix" }),
      session({ id: "b", agent: "codex", provider: "neolix", usesProvider: "neolix" }),
      session({ id: "c", agent: "codex", provider: "custom" }),
      session({ id: "d", agent: "claude", provider: "custom", usesProvider: "neolix" }),
    ]);

    expect(hidden.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("puts a speaker heading and a model only where each changes", () => {
    const lines = talkLines([
      { role: "user", kind: "text", text: "Hi" },
      { role: "assistant", kind: "text", text: "Hello", model: "m1" },
      { role: "assistant", kind: "tool_use", name: "Bash", text: "{}" },
      { role: "tool", kind: "tool_result", text: "ok" },
      { role: "assistant", kind: "text", text: "Done", model: "m2" },
      { role: "user", kind: "text", text: "Thanks" },
      { role: "assistant", kind: "text", text: "Bye", model: "m2" },
    ]);

    expect(lines.map((line) => [line.heading, line.model])).toEqual([
      ["user", ""],
      ["assistant", "m1"],
      [null, ""],
      [null, ""],
      [null, "m2"],
      ["user", ""],
      ["assistant", "m2"],
    ]);
  });
});
