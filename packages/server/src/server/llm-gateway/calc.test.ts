import { describe, expect, it } from "vitest";
import { calcConvert, calcDate, calcEval } from "./calc.js";

interface EvalResult {
  exact?: string;
  decimal?: string;
  rounded?: string;
  error?: string;
}

interface ConvertResult {
  exact?: string;
  decimal?: string;
  rounded?: string;
  unit?: string;
  error?: string;
}

interface DateFields {
  iso?: string;
  local?: string;
  timeZone?: string;
  weekday?: string;
  unix?: number;
  unixMs?: number;
  dayOfYear?: number;
  isoWeek?: string;
  error?: string;
}

interface BetweenFields {
  calendar?: string;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  ms?: number;
}

interface DateResult extends DateFields {
  to?: DateFields;
  between?: BetweenFields;
}

function evalResult(expression: string, places?: number): EvalResult {
  return JSON.parse(calcEval(expression, places)) as EvalResult;
}

function convertResult(value: string, from: string, to: string, places?: number): ConvertResult {
  return JSON.parse(calcConvert(value, from, to, places)) as ConvertResult;
}

function dateResult(input: Parameters<typeof calcDate>[0]): DateResult {
  return JSON.parse(calcDate(input)) as DateResult;
}

describe("calcEval", () => {
  it("returns an exact fraction and a terminating decimal", () => {
    expect(evalResult("0.1+0.2")).toEqual({ exact: "3/10", decimal: "0.3" });
  });

  it("returns a plain integer when the denominator is one", () => {
    expect(evalResult("2^10")).toEqual({ exact: "1024", decimal: "1024" });
  });

  it("rounds recurring decimals to twenty places by default", () => {
    expect(evalResult("1/3")).toEqual({
      exact: "1/3",
      decimal: "0.33333333333333333333",
      rounded: "to 20 places",
    });
  });

  it("honours the places argument and rounds half away from zero", () => {
    expect(evalResult("1/3", 5)).toEqual({
      exact: "1/3",
      decimal: "0.33333",
      rounded: "to 5 places",
    });
    expect(evalResult("2/3")).toEqual({
      exact: "2/3",
      decimal: "0.66666666666666666667",
      rounded: "to 20 places",
    });
    expect(evalResult("0.15", 1)).toEqual({
      exact: "3/20",
      decimal: "0.2",
      rounded: "to 1 places",
    });
    expect(evalResult("0.05", 1)).toEqual({
      exact: "1/20",
      decimal: "0.1",
      rounded: "to 1 places",
    });
    expect(evalResult("1/4", 1)).toEqual({ exact: "1/4", decimal: "0.3", rounded: "to 1 places" });
    expect(evalResult("9.99", 1)).toEqual({
      exact: "999/100",
      decimal: "10",
      rounded: "to 1 places",
    });
    expect(evalResult("-9.99", 1)).toEqual({
      exact: "-999/100",
      decimal: "-10",
      rounded: "to 1 places",
    });
  });

  it("caps places at one thousand", () => {
    const result = evalResult("1/3", 2000);
    expect(result.rounded).toBe("to 1000 places");
    expect(result.decimal).toBe(`0.${"3".repeat(1000)}`);
  });

  it("supports both power spellings and right associativity", () => {
    expect(evalResult("2**10")).toEqual({ exact: "1024", decimal: "1024" });
    expect(evalResult("2^3^2")).toEqual({ exact: "512", decimal: "512" });
    expect(evalResult("-2^2")).toEqual({ exact: "-4", decimal: "-4" });
    expect(evalResult("2^-1")).toEqual({ exact: "1/2", decimal: "0.5" });
  });

  it("supports radix, exponent and underscore literals", () => {
    expect(evalResult("0x1F + 0b101 + 0o17 + 1_000")).toEqual({ exact: "1051", decimal: "1051" });
    expect(evalResult("0x1_FF")).toEqual({ exact: "511", decimal: "511" });
    expect(evalResult("1e3 + 1.5e-2")).toEqual({ exact: "200003/200", decimal: "1000.015" });
    expect(evalResult(".5")).toEqual({ exact: "1/2", decimal: "0.5" });
  });

  it("supports the documented functions", () => {
    expect(evalResult("abs(-3/4)")).toEqual({ exact: "3/4", decimal: "0.75" });
    expect(evalResult("floor(-2.5)")).toEqual({ exact: "-3", decimal: "-3" });
    expect(evalResult("ceil(-2.5)")).toEqual({ exact: "-2", decimal: "-2" });
    expect(evalResult("round(2.5)")).toEqual({ exact: "3", decimal: "3" });
    expect(evalResult("round(-2.5)")).toEqual({ exact: "-3", decimal: "-3" });
    expect(evalResult("trunc(-2.7)")).toEqual({ exact: "-2", decimal: "-2" });
    expect(evalResult("min(1/3,2/5,0.2)")).toEqual({ exact: "1/5", decimal: "0.2" });
    expect(evalResult("max(1/3,2/5,0.2)")).toEqual({ exact: "2/5", decimal: "0.4" });
    expect(evalResult("gcd(12,18,24)")).toEqual({ exact: "6", decimal: "6" });
    expect(evalResult("gcd(-12,18)")).toEqual({ exact: "6", decimal: "6" });
    expect(evalResult("lcm(4,6)")).toEqual({ exact: "12", decimal: "12" });
    expect(evalResult("fact(5)")).toEqual({ exact: "120", decimal: "120" });
    expect(evalResult("fact(0)")).toEqual({ exact: "1", decimal: "1" });
  });

  it("reduces exact results", () => {
    expect(evalResult("10/4")).toEqual({ exact: "5/2", decimal: "2.5" });
    expect(evalResult("1/3+1/6")).toEqual({ exact: "1/2", decimal: "0.5" });
  });

  it("uses truncated modulo like JavaScript", () => {
    expect(evalResult("7%3")).toEqual({ exact: "1", decimal: "1" });
    expect(evalResult("-7%3")).toEqual({ exact: "-1", decimal: "-1" });
    expect(evalResult("7%-3")).toEqual({ exact: "1", decimal: "1" });
    expect(evalResult("5%2.5")).toEqual({ exact: "0", decimal: "0" });
    expect(evalResult("(1/3)%(1/6)")).toEqual({ exact: "0", decimal: "0" });
  });

  it("returns a JSON error for invalid input", () => {
    expect(evalResult("1/0")).toEqual({ error: "division by zero" });
    expect(evalResult("1%0")).toEqual({ error: "division by zero" });
    expect(evalResult("")).toEqual({ error: "no expression" });
    expect(evalResult("1+")).toEqual({ error: "the expression ends too soon" });
    expect(evalResult("(1+2").error).toBe('expected ")" before the end');
    expect(evalResult("foo(1)").error).toContain("no function foo:");
    expect(evalResult("gcd(1/2,3/4)")).toEqual({ error: "gcd takes whole numbers" });
    expect(evalResult("lcm(1/2,3/4)")).toEqual({ error: "lcm takes whole numbers" });
    expect(evalResult("fact(-1)")).toEqual({ error: "fact takes a whole number from 0 to 5000" });
    expect(evalResult("fact(5001)")).toEqual({ error: "fact takes a whole number from 0 to 5000" });
    expect(evalResult("2^0.5").error).toBe(
      "a power must be a whole number: this answers exactly, and x^(1/2) mostly isn't",
    );
    expect(evalResult("1e999999").error).toBe("exponent too big: 1e999999");
  });
});

describe("calcConvert", () => {
  it("converts the documented GiB to MB example exactly", () => {
    expect(convertResult("1.5", "GiB", "MB")).toEqual({
      exact: "25165824/15625",
      decimal: "1610.612736",
      unit: "MB",
    });
  });

  it("evaluates expressions in the value", () => {
    expect(convertResult("3*1024", "B", "KiB")).toEqual({ exact: "3", decimal: "3", unit: "KiB" });
  });

  it("rounds non-terminating conversions", () => {
    expect(convertResult("1", "MB", "GiB", 5)).toEqual({
      exact: "15625/16777216",
      decimal: "0.00093",
      rounded: "to 5 places",
      unit: "GiB",
    });
    expect(convertResult("1", "MB", "GiB").decimal).toBe("0.00093132257461547852");
  });

  it("converts data units using decimal and binary prefixes", () => {
    expect(convertResult("1", "B", "bit")).toEqual({ exact: "8", decimal: "8", unit: "bit" });
    expect(convertResult("1", "KiB", "bit")).toEqual({
      exact: "8192",
      decimal: "8192",
      unit: "bit",
    });
    expect(convertResult("1", "EiB", "EB")).toEqual({
      exact: "4398046511104/3814697265625",
      decimal: "1.152921504606846976",
      unit: "EB",
    });
  });

  it("converts time, length, mass and angle units", () => {
    expect(convertResult("1", "h", "s")).toEqual({ exact: "3600", decimal: "3600", unit: "s" });
    expect(convertResult("1", "mi", "m")).toEqual({
      exact: "201168/125",
      decimal: "1609.344",
      unit: "m",
    });
    expect(convertResult("1", "lb", "kg")).toEqual({
      exact: "45359237/100000000",
      decimal: "0.45359237",
      unit: "kg",
    });
    expect(convertResult("180", "deg", "turn")).toEqual({
      exact: "1/2",
      decimal: "0.5",
      unit: "turn",
    });
    expect(convertResult("1", "grad", "deg")).toEqual({
      exact: "9/10",
      decimal: "0.9",
      unit: "deg",
    });
  });

  it("converts temperatures with an affine transform", () => {
    expect(convertResult("100", "C", "F")).toEqual({ exact: "212", decimal: "212", unit: "F" });
    expect(convertResult("32", "F", "C")).toEqual({ exact: "0", decimal: "0", unit: "C" });
    expect(convertResult("98.6", "F", "C")).toEqual({ exact: "37", decimal: "37", unit: "C" });
    expect(convertResult("0", "C", "K")).toEqual({
      exact: "5463/20",
      decimal: "273.15",
      unit: "K",
    });
    expect(convertResult("1", "K", "F")).toEqual({
      exact: "-45787/100",
      decimal: "-457.87",
      unit: "F",
    });
  });

  it("reports unknown units with the full unit table", () => {
    const result = convertResult("1", "bogus", "MB");
    expect(
      result.error?.startsWith("no unit bogus: bit bits B byte bytes kB KB KiB kb Kb kbit"),
    ).toBe(true);
    expect(result.error).toContain("in-css mg g kg t oz lb deg turn grad C F K");
    expect(convertResult("1", "MB", "xyz").error?.startsWith("no unit xyz: ")).toBe(true);
    expect(convertResult("1", "b", "MB").error?.startsWith("no unit b: ")).toBe(true);
  });

  it("reports category mismatches", () => {
    expect(convertResult("1", "B", "s")).toEqual({ error: "B is data and s is time" });
    expect(convertResult("1", "C", "m")).toEqual({ error: "can't convert C to m" });
  });

  it("reports invalid value expressions", () => {
    expect(convertResult("1+", "B", "KB")).toEqual({ error: "the expression ends too soon" });
    expect(convertResult("abc", "B", "KB").error?.startsWith("no function abc:")).toBe(true);
  });
});

describe("calcDate", () => {
  it("matches the documented thirty day example", () => {
    expect(dateResult({ date: "2026-01-01", add: "30d" })).toEqual({
      iso: "2026-01-31T00:00:00.000Z",
      weekday: "Saturday",
      unix: 1769817600,
      unixMs: 1769817600000,
      dayOfYear: 31,
      isoWeek: "2026-W05",
    });
  });

  it("parses date-only, ISO, seconds and milliseconds", () => {
    const expected = {
      iso: "2026-01-01T00:00:00.000Z",
      weekday: "Thursday",
      unix: 1767225600,
      unixMs: 1767225600000,
      dayOfYear: 1,
      isoWeek: "2026-W01",
    };
    expect(dateResult({ date: "2026-01-01" })).toEqual(expected);
    expect(dateResult({ date: "1767225600" })).toEqual(expected);
    expect(dateResult({ date: "1767225600000" })).toEqual(expected);
    expect(dateResult({ date: "0" }).iso).toBe("1970-01-01T00:00:00.000Z");
    expect(dateResult({ date: "2026-01-01T12:34:56Z" }).iso).toBe("2026-01-01T12:34:56.000Z");
  });

  it("shifts with compact, word and ISO durations", () => {
    expect(dateResult({ date: "2026-01-01", add: "1y2mo" }).iso).toBe("2027-03-01T00:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "P1M" }).iso).toBe("2026-02-01T00:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "3d 4h" }).iso).toBe("2026-01-04T04:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "-2w" }).iso).toBe("2025-12-18T00:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "-90m" }).iso).toBe("2025-12-31T22:30:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "1.5d" }).iso).toBe("2026-01-02T12:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "PT1H30M" }).iso).toBe("2026-01-01T01:30:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "1M" }).iso).toBe("2026-01-01T00:01:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "1 month" }).iso).toBe("2026-02-01T00:00:00.000Z");
  });

  it("clamps calendar arithmetic at month ends", () => {
    expect(dateResult({ date: "2026-01-31", add: "1mo" }).iso).toBe("2026-02-28T00:00:00.000Z");
    expect(dateResult({ date: "2024-02-29", add: "1y" }).iso).toBe("2025-02-28T00:00:00.000Z");
    expect(dateResult({ date: "2026-01-01", add: "-1mo" }).iso).toBe("2025-12-01T00:00:00.000Z");
  });

  it("returns the second date and the difference for to", () => {
    const result = dateResult({ date: "2026-01-01", to: "2026-03-01" });
    expect(result.iso).toBe("2026-01-01T00:00:00.000Z");
    expect(result.to).toEqual({
      iso: "2026-03-01T00:00:00.000Z",
      weekday: "Sunday",
      unix: 1772323200,
      unixMs: 1772323200000,
      dayOfYear: 60,
      isoWeek: "2026-W09",
    });
    expect(result.between).toEqual({
      calendar: "2mo",
      days: 59,
      hours: 1416,
      minutes: 84960,
      seconds: 5097600,
      ms: 5097600000,
    });
  });

  it("reports differences with a trailing sign", () => {
    expect(dateResult({ date: "2026-01-10", to: "2026-01-01" }).between?.calendar).toBe("-9d");
    expect(
      dateResult({ date: "2026-01-01T10:00:00Z", to: "2026-01-02T12:30:45Z" }).between,
    ).toEqual({
      calendar: "1d 2h 30m 45s",
      days: 1.1046875,
      hours: 26.5125,
      minutes: 1590.75,
      seconds: 95445,
      ms: 95445000,
    });
    expect(dateResult({ date: "2026-01-31", to: "2026-02-28" }).between?.calendar).toBe("1mo");
    expect(dateResult({ date: "2026-03-31", to: "2026-02-28" }).between?.calendar).toBe("-1mo 3d");
  });

  it("uses the time zone for parsing and for calendar fields", () => {
    expect(dateResult({ date: "2026-01-01", timeZone: "America/New_York" })).toEqual({
      iso: "2026-01-01T05:00:00.000Z",
      local: "2026-01-01T00:00:00-05:00",
      timeZone: "America/New_York",
      weekday: "Thursday",
      unix: 1767243600,
      unixMs: 1767243600000,
      dayOfYear: 1,
      isoWeek: "2026-W01",
    });
    expect(dateResult({ date: "2026-01-01", timeZone: "Asia/Shanghai" })).toMatchObject({
      iso: "2025-12-31T16:00:00.000Z",
      local: "2026-01-01T00:00:00+08:00",
      timeZone: "Asia/Shanghai",
      dayOfYear: 1,
      isoWeek: "2026-W01",
    });
    expect(dateResult({ date: "2026-01-01T00:00:00", timeZone: "America/New_York" }).iso).toBe(
      "2026-01-01T05:00:00.000Z",
    );
  });

  it("keeps the local wall clock across a DST change", () => {
    expect(
      dateResult({ date: "2026-03-07T12:00:00Z", add: "1d", timeZone: "America/New_York" }),
    ).toMatchObject({
      iso: "2026-03-08T11:00:00.000Z",
      local: "2026-03-08T07:00:00-04:00",
    });
    expect(
      dateResult({ date: "2026-03-08T06:30:00Z", add: "1h", timeZone: "America/New_York" }),
    ).toMatchObject({
      iso: "2026-03-08T07:30:00.000Z",
      local: "2026-03-08T03:30:00-04:00",
    });
  });

  it("computes ISO week fields in UTC without a time zone", () => {
    expect(dateResult({ date: "2026-01-01T00:00:00+08:00" })).toMatchObject({
      iso: "2025-12-31T16:00:00.000Z",
      dayOfYear: 365,
      isoWeek: "2026-W01",
    });
  });

  it("returns JSON errors for bad input", () => {
    expect(dateResult({ date: "not-a-date" }).error).toBe(
      'not a date: not-a-date (ISO 8601, unix seconds or ms, or "now")',
    );
    expect(dateResult({ date: "2026-02-30" })).toEqual({ error: "no such date: 2026-02-30" });
    expect(dateResult({ date: "2026-01-01", timeZone: "Bad/Zone" }).error).toBe(
      "no time zone Bad/Zone: an IANA name such as Europe/Berlin or Asia/Shanghai",
    );
    expect(dateResult({ date: "2026-01-01", add: "bogus" }).error).toBe(
      'not a duration: bogus (like "3d 4h", "-90m", "1y2mo" or "P1DT2H")',
    );
    expect(dateResult({ date: "2026-01-01", add: "1.5mo" })).toEqual({
      error: "1.5mo: years and months are whole",
    });
  });

  it("defaults to now", () => {
    const result = dateResult({});
    expect(result.error).toBeUndefined();
    expect(typeof result.iso).toBe("string");
    expect(Number.isNaN(Date.parse(result.iso ?? ""))).toBe(false);
    expect(typeof result.unix).toBe("number");
    expect(result.isoWeek).toMatch(/^\d{4}-W\d{2}$/);
  });
});
