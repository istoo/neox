import { describe, expect, it } from "vitest";
import type { GatewayGroupRuleWire } from "@neolix/protocol/gateway";
import {
  cleanFolder,
  daysText,
  groupMember,
  inZoneHere,
  localZone,
  parseDays,
  parseRuleLine,
  parseTimeWindow,
  parseTokens,
  ruleLine,
  ruleWords,
  withParsedRule,
} from "./rules.js";

const group = {
  id: "work",
  members: ["openai/gpt-5", "anthropic/claude:high", "google/gemini"],
  classifier: "openai/gpt-5-mini",
};

function onlyRule(line: string, at: typeof group = group): GatewayGroupRuleWire {
  return parseRuleLine(line, at).rule;
}

describe("rule language", () => {
  it("reads every field myna's parser does", () => {
    const parsed = parseRuleLine(
      'use=gpt-5,claude use-effort=high tokens=200k images effort=on agents=codex,claude intent="writing or fixing tests" compact time=22:00-08:00 days=mon-fri tz=Asia/Shanghai folders=~/work,"~/My Project" except-folders=~/old at=2 classifier=openai/gpt-5-mini',
      group,
    );
    expect(parsed.at).toBe(2);
    expect(parsed.classifier).toBe("openai/gpt-5-mini");
    expect(parsed.rule).toEqual({
      use: "openai/gpt-5",
      more: ["anthropic/claude:high"],
      useEffort: "high",
      tokens: 200_000,
      images: true,
      effort: "on",
      agents: ["codex", "claude"],
      intent: "writing or fixing tests",
      compact: true,
      time: {
        from: "22:00",
        to: "08:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
        zone: "Asia/Shanghai",
      },
      folders: ["~/work", "~/My Project"],
      exceptFolders: ["~/old"],
    });
  });

  it("round-trips a rule through its typed line", () => {
    const parsed = onlyRule(
      'use=gpt-5,gemini use-effort=medium tokens=1.5m images effort=high agents=codex intent="tests, fixes" compact time=22:00-08:00 days=mon-fri tz=Europe/Berlin folders=~/work,"~/My Project" except-folders=~/old',
    );
    const line = ruleLine(parsed);
    expect(line).toBe(
      'use=openai/gpt-5,google/gemini use-effort=medium tokens=1500000 images effort=high agents=codex intent="tests, fixes" compact time=22:00-08:00 days=mon-fri tz=Europe/Berlin folders="~/work,~/My Project" except-folders=~/old',
    );
    expect(onlyRule(line)).toEqual(parsed);
  });

  it("reads pauses and their conditions", () => {
    const rule = onlyRule("pause=gemini time=09:00-18:00 days=sat,sun folders=~/work");
    expect(rule).toMatchObject({
      use: "google/gemini",
      pause: true,
      time: { from: "09:00", to: "18:00", days: ["sat", "sun"] },
      folders: ["~/work"],
    });
    expect(rule.more).toBeUndefined();
    expect(rule.useEffort).toBeUndefined();
  });

  it("reads token lengths", () => {
    expect(parseTokens("200000")).toBe(200_000);
    expect(parseTokens("200k")).toBe(200_000);
    expect(parseTokens("1.5m")).toBe(1_500_000);
    expect(parseTokens("200_000")).toBe(200_000);
    expect(() => parseTokens("long")).toThrow('tokens "long" is not a length');
    expect(() => parseTokens("-1")).toThrow('tokens "-1" is not a length');
  });

  it("reads weekday lists and ranges that wrap", () => {
    expect(parseDays("mon-fri")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(parseDays("sat,sun")).toEqual(["sat", "sun"]);
    expect(parseDays("fri-mon")).toEqual(["fri", "sat", "sun", "mon"]);
    expect(parseDays("Monday, wed-friday")).toEqual(["mon", "wed", "thu", "fri"]);
    expect(() => parseDays("funday")).toThrow('days: "funday" is not a day of the week');
    expect(() => parseDays("")).toThrow("days names the days of the week it holds on");
  });

  it("writes days the way myna does", () => {
    expect(daysText(["mon", "tue", "wed", "thu", "fri"])).toBe("Mon–Fri");
    expect(daysText(["sat", "sun"])).toBe("Sat,Sun");
    expect(daysText(["mon", "fri", "sat", "sun"])).toBe("Mon,Fri–Sun");
    expect(daysText([])).toBe("");
    expect(onlyRule("use=gpt-5 days=fri-mon")).toMatchObject({
      time: { from: "00:00", to: "00:00", days: ["fri", "sat", "sun", "mon"] },
    });
    expect(ruleLine(onlyRule("use=gpt-5 days=fri-mon"))).toBe("use=openai/gpt-5 days=mon,fri-sun");
  });

  it("reads time windows and zones", () => {
    expect(parseTimeWindow("09:00-18:00")).toEqual({ from: "09:00", to: "18:00" });
    expect(parseTimeWindow("9:05–18:00@Asia/Shanghai")).toEqual({
      from: "09:05",
      to: "18:00",
      zone: "Asia/Shanghai",
    });
    expect(() => parseTimeWindow("09:00")).toThrow("time is hours of the day");
    expect(() => parseTimeWindow("25:00-18:00")).toThrow('the time "25:00" is not HH:MM');
    expect(() => parseTimeWindow("09:00-18:00@Mars/Base")).toThrow(
      'the time zone "Mars/Base" is not one myna knows',
    );
  });

  it("splits quoted words", () => {
    expect(ruleWords('intent="a  quick question" compact')).toEqual([
      "intent=a  quick question",
      "compact",
    ]);
    expect(ruleWords("  one\ttwo  ")).toEqual(["one", "two"]);
  });

  it("resolves members by id, bare model and fixed effort", () => {
    expect(groupMember(group, "openai/gpt-5")).toBe("openai/gpt-5");
    expect(groupMember(group, "GPT-5")).toBe("openai/gpt-5");
    expect(groupMember(group, "gpt-5")).toBe("openai/gpt-5");
    expect(groupMember(group, "claude")).toBe("anthropic/claude:high");
    expect(groupMember(group, "anthropic/claude")).toBe("anthropic/claude:high");
    expect(groupMember(group, "myna/google/gemini")).toBe("google/gemini");
    expect(() => groupMember(group, "mistral")).toThrow(
      "mistral is not in work (its models: openai/gpt-5, anthropic/claude:high, google/gemini)",
    );
    expect(() => groupMember({ id: "g", members: ["a/x", "b/x"] }, "x")).toThrow(
      "x is a/x and b/x: name one",
    );
  });

  it("cleans folders as whole paths", () => {
    expect(cleanFolder("~/work/")).toBe("~/work");
    expect(cleanFolder("/")).toBe("/");
    expect(cleanFolder("C:\\")).toBe("C:\\");
    expect(cleanFolder("C:\\work")).toBe("C:\\work");
    expect(cleanFolder("\\\\wsl$\\Ubuntu\\work")).toBe("\\\\wsl$\\Ubuntu\\work");
    expect(() => cleanFolder("work/acme")).toThrow('the folder "work/acme" is not a whole path');
  });

  it("puts a window with no zone on this computer's clock", () => {
    const rule = onlyRule("use=gpt-5 time=09:00-18:00");
    const zoned = inZoneHere(rule);
    if (localZone() === "") {
      expect(zoned.time).toEqual(rule.time);
    } else {
      expect(zoned.time?.zone).toBe(localZone());
    }
  });

  it("rejects what myna rejects", () => {
    expect(() => parseRuleLine("tokens=1k", group)).toThrow(
      "use=<model> (or pause=<model>) is missing",
    );
    expect(() => parseRuleLine("use=", group)).toThrow("use=<model> names the model it sends to");
    expect(() => parseRuleLine("use=gpt-5 wonder=1", group)).toThrow('unknown "wonder=1"');
    expect(() => parseRuleLine("use=gpt-5 images=maybe", group)).toThrow(
      'images takes no value (or yes/no), not "maybe"',
    );
    expect(() => parseRuleLine("use=gpt-5 compact=maybe", group)).toThrow(
      'compact takes no value (or yes/no), not "maybe"',
    );
    expect(() => parseRuleLine("use=gpt-5 use-effort=ultra", group)).toThrow(
      "use-effort is the reasoning the rule's model is asked for",
    );
    expect(() => parseRuleLine("use=gpt-5 tz=Asia/Shanghai", group)).toThrow(
      "tz= is the time zone of time= or days=",
    );
    expect(() => parseRuleLine("use=gpt-5 tz=Mars/Base", group)).toThrow(
      'tz: "Mars/Base" is not a time zone',
    );
    expect(() => parseRuleLine("pause=gpt-5 use=gpt-5,gemini", group)).toThrow(
      "pause=<model> names one model",
    );
    expect(() => parseRuleLine("pause=gpt-5 time=09:00-18:00 use-effort=low", group)).toThrow(
      "pause=<model> sends nothing, so it takes no use-effort=",
    );
    expect(() => parseRuleLine("pause=gpt-5 time=09:00-18:00 tokens=1k", group)).toThrow(
      "pause=<model> holds by time=, days=, agents=, folders= or except-folders= only",
    );
    expect(() => parseRuleLine("pause=gpt-5", group)).toThrow(
      "pause=<model> needs time=, days=, agents=, folders= or except-folders=",
    );
    expect(() =>
      parseRuleLine('use=gpt-5 intent="hello"', { ...group, classifier: undefined }),
    ).toThrow("a rule with an intent needs the group's classifier");
    expect(() => parseRuleLine(`use=gpt-5 intent="${"字".repeat(201)}"`, group)).toThrow(
      "an intent is at most 200 characters",
    );
    expect(() => parseRuleLine("use=gpt-5 at=0", group)).toThrow('at is a place from 1, not "0"');
    expect(() => parseRuleLine("use=gpt-5 classifier=", group)).toThrow(
      "classifier=<model>: the model that tells which intent a message is",
    );
    expect(() => parseRuleLine("use=gpt-5 folders=", group)).toThrow(
      "folders names the working folders it holds in",
    );
    expect(() => parseRuleLine("use=gpt-5 folders=work/acme", group)).toThrow(
      "is not a whole path",
    );
    expect(() => parseRuleLine("use=gpt-5 except-folders=", group)).toThrow(
      "except-folders names the working folders it doesn't hold in",
    );
    expect(() => parseRuleLine('use=gpt-5 intent=""', group)).toThrow(
      "intent says what the message asks for",
    );
  });

  it("inserts, moves and replaces rules like putRule", () => {
    const first = onlyRule("use=gpt-5");
    const second = onlyRule("use=gemini");
    expect(withParsedRule({ ...group, rules: [] }, -1, "use=gpt-5").rules).toEqual([first]);
    expect(
      withParsedRule({ ...group, rules: [first, second] }, -1, "use=gemini at=1").rules,
    ).toEqual([second, first, second]);
    expect(withParsedRule({ ...group, rules: [first, second] }, 0, "use=gemini").rules).toEqual([
      second,
      second,
    ]);
    expect(
      withParsedRule({ ...group, rules: [first, second] }, 0, "use=gemini at=2").rules,
    ).toEqual([second, second]);
    const classified = withParsedRule(
      { ...group, classifier: undefined, rules: [] },
      -1,
      "use=gpt-5 classifier=openai/gpt-5-mini",
    );
    expect(classified.classifier).toBe("openai/gpt-5-mini");
  });
});
