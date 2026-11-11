/**
 * Exact arithmetic, unit conversion and calendar helpers mirroring myna's calc plugin.
 *
 * Every public function returns a JSON string so callers can hand the result straight
 * to a model. Errors are returned as `{"error":"..."}` rather than thrown.
 */

interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

const MAX_PLACES = 1000;
const DEFAULT_PLACES = 20;
const MAX_POWER_EXPONENT = 100000;
const MAX_LITERAL_EXPONENT = 99999;
const MAX_FACTORIAL = 5000;

function bigintAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function bigintGcd(left: bigint, right: bigint): bigint {
  let a = bigintAbs(left);
  let b = bigintAbs(right);
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function fraction(num: bigint, den: bigint): Fraction {
  if (den === 0n) {
    throw new Error("division by zero");
  }
  const sign = den < 0n ? -1n : 1n;
  const numerator = num * sign;
  const denominator = den * sign;
  const divisor = bigintGcd(numerator, denominator);
  if (divisor === 0n) {
    return { num: 0n, den: 1n };
  }
  return { num: numerator / divisor, den: denominator / divisor };
}

function fractionFromInt(value: bigint): Fraction {
  return { num: value, den: 1n };
}

function addFractions(left: Fraction, right: Fraction): Fraction {
  return fraction(left.num * right.den + right.num * left.den, left.den * right.den);
}

function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return fraction(left.num * right.den - right.num * left.den, left.den * right.den);
}

function multiplyFractions(left: Fraction, right: Fraction): Fraction {
  return fraction(left.num * right.num, left.den * right.den);
}

function divideFractions(left: Fraction, right: Fraction): Fraction {
  if (right.num === 0n) {
    throw new Error("division by zero");
  }
  return fraction(left.num * right.den, left.den * right.num);
}

function moduloFractions(left: Fraction, right: Fraction): Fraction {
  if (right.num === 0n) {
    throw new Error("division by zero");
  }
  const quotient = truncFraction(divideFractions(left, right));
  return subtractFractions(left, multiplyFractions(quotient, right));
}

function negateFraction(value: Fraction): Fraction {
  return { num: -value.num, den: value.den };
}

function truncFraction(value: Fraction): Fraction {
  return fractionFromInt(value.num / value.den);
}

function floorFraction(value: Fraction): Fraction {
  const quotient = value.num / value.den;
  const remainder = value.num % value.den;
  if (remainder !== 0n && value.num < 0n) {
    return fractionFromInt(quotient - 1n);
  }
  return fractionFromInt(quotient);
}

function ceilFraction(value: Fraction): Fraction {
  const quotient = value.num / value.den;
  const remainder = value.num % value.den;
  if (remainder !== 0n && value.num > 0n) {
    return fractionFromInt(quotient + 1n);
  }
  return fractionFromInt(quotient);
}

function roundFraction(value: Fraction): Fraction {
  const magnitude = bigintAbs(value.num);
  let quotient = magnitude / value.den;
  const remainder = magnitude % value.den;
  if (remainder * 2n >= value.den) {
    quotient += 1n;
  }
  return fractionFromInt(value.num < 0n ? -quotient : quotient);
}

function compareFractions(left: Fraction, right: Fraction): number {
  const delta = left.num * right.den - right.num * left.den;
  if (delta < 0n) {
    return -1;
  }
  if (delta > 0n) {
    return 1;
  }
  return 0;
}

function formatFraction(value: Fraction): string {
  if (value.den === 1n) {
    return value.num.toString();
  }
  return `${value.num}/${value.den}`;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

interface DecimalResult {
  decimal: string;
  rounded: boolean;
}

function formatFractionDecimal(value: Fraction, places: number): DecimalResult {
  const negative = value.num < 0n;
  const magnitude = bigintAbs(value.num);
  const scale = pow10(places);
  const scaled = magnitude * scale;
  let integer = scaled / value.den;
  const remainder = scaled % value.den;
  if (remainder * 2n >= value.den) {
    integer += 1n;
  }
  const digits = integer.toString().padStart(places + 1, "0");
  const splitAt = digits.length - places;
  const whole = digits.slice(0, splitAt);
  const fractionDigits = places === 0 ? "" : digits.slice(splitAt).replace(/0+$/, "");
  const magnitudeText = fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : whole;
  const decimal = negative && integer !== 0n ? `-${magnitudeText}` : magnitudeText;
  return { decimal, rounded: remainder !== 0n };
}

function normalizePlaces(places: number | undefined): number {
  if (places === undefined || Number.isNaN(places)) {
    return DEFAULT_PLACES;
  }
  const truncated = Math.trunc(places);
  if (truncated < 0) {
    return 0;
  }
  if (truncated > MAX_PLACES) {
    return MAX_PLACES;
  }
  return truncated;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorJson(error: unknown): string {
  return JSON.stringify({ error: errorMessage(error) });
}

const FUNCTION_LIST = "abs, floor, ceil, round, trunc, min, max, gcd, lcm, fact";

function applyNamedFunction(name: string, args: Fraction[]): Fraction {
  switch (name) {
    case "abs":
      requireArity(args, `${name} takes one number`);
      return { num: bigintAbs(args[0].num), den: args[0].den };
    case "floor":
      requireArity(args, `${name} takes one number`);
      return floorFraction(args[0]);
    case "ceil":
      requireArity(args, `${name} takes one number`);
      return ceilFraction(args[0]);
    case "round":
      requireArity(args, `${name} takes one number`);
      return roundFraction(args[0]);
    case "trunc":
      requireArity(args, `${name} takes one number`);
      return truncFraction(args[0]);
    case "min":
      return foldFractions(args, (left, right) =>
        compareFractions(left, right) <= 0 ? left : right,
      );
    case "max":
      return foldFractions(args, (left, right) =>
        compareFractions(left, right) >= 0 ? left : right,
      );
    case "gcd":
      return foldWholeNumbers(name, args, (left, right) => bigintGcd(left, right));
    case "lcm":
      return foldWholeNumbers(name, args, (left, right) => {
        if (left === 0n || right === 0n) {
          return 0n;
        }
        return bigintAbs((left / bigintGcd(left, right)) * right);
      });
    case "fact":
      requireArity(args, "fact takes a whole number from 0 to 5000");
      return factorialFraction(args[0]);
    default:
      throw new Error(`no function ${name}: ${FUNCTION_LIST}`);
  }
}

function requireArity(args: Fraction[], message: string): void {
  if (args.length !== 1) {
    throw new Error(message);
  }
}

function foldFractions(
  args: Fraction[],
  pick: (left: Fraction, right: Fraction) => Fraction,
): Fraction {
  let result = args[0];
  for (let index = 1; index < args.length; index += 1) {
    result = pick(result, args[index]);
  }
  return result;
}

function foldWholeNumbers(
  name: string,
  args: Fraction[],
  pick: (left: bigint, right: bigint) => bigint,
): Fraction {
  if (args.length < 2) {
    throw new Error(`${name} takes two or more whole numbers`);
  }
  let result = 0n;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].den !== 1n) {
      throw new Error(`${name} takes whole numbers`);
    }
    result = index === 0 ? args[index].num : pick(result, args[index].num);
  }
  return fractionFromInt(result);
}

function factorialFraction(value: Fraction): Fraction {
  if (value.den !== 1n || value.num < 0n || value.num > BigInt(MAX_FACTORIAL)) {
    throw new Error("fact takes a whole number from 0 to 5000");
  }
  let result = 1n;
  for (let index = 2n; index <= value.num; index += 1n) {
    result *= index;
  }
  return fractionFromInt(result);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isLetter(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

function isIdentifierChar(character: string): boolean {
  return isLetter(character) || isDigit(character) || character === "_";
}

class ExpressionParser {
  private readonly input: string;
  private position = 0;

  constructor(input: string) {
    this.input = input;
  }

  parse(): Fraction {
    this.skipSpace();
    if (this.position >= this.input.length) {
      throw new Error("no expression");
    }
    const value = this.parseAdditive();
    this.skipSpace();
    if (this.position < this.input.length) {
      throw new Error(this.unexpected());
    }
    return value;
  }

  private peek(): string {
    return this.input[this.position] ?? "";
  }

  private skipSpace(): void {
    while (this.position < this.input.length) {
      const character = this.input[this.position];
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        this.position += 1;
        continue;
      }
      break;
    }
  }

  private unexpected(): string {
    const rest = this.input.slice(this.position);
    if (rest.length === 0) {
      return "the expression ends too soon";
    }
    const token = /^[A-Za-z0-9_.]+/.exec(rest);
    if (token === null) {
      return `unexpected "${rest[0]}"`;
    }
    return `unexpected "${token[0]}"`;
  }

  private parseAdditive(): Fraction {
    let value = this.parseMultiplicative();
    for (;;) {
      this.skipSpace();
      const operator = this.peek();
      if (operator !== "+" && operator !== "-") {
        return value;
      }
      this.position += 1;
      const right = this.parseMultiplicative();
      value = operator === "+" ? addFractions(value, right) : subtractFractions(value, right);
    }
  }

  private parseMultiplicative(): Fraction {
    let value = this.parseUnary();
    for (;;) {
      this.skipSpace();
      const operator = this.peek();
      if (operator !== "*" && operator !== "/" && operator !== "%") {
        return value;
      }
      if (operator === "*" && this.input[this.position + 1] === "*") {
        return value;
      }
      this.position += 1;
      const right = this.parseUnary();
      if (operator === "*") {
        value = multiplyFractions(value, right);
      } else if (operator === "/") {
        value = divideFractions(value, right);
      } else {
        value = moduloFractions(value, right);
      }
    }
  }

  private parseUnary(): Fraction {
    this.skipSpace();
    const operator = this.peek();
    if (operator === "+") {
      this.position += 1;
      return this.parseUnary();
    }
    if (operator === "-") {
      this.position += 1;
      return negateFraction(this.parseUnary());
    }
    return this.parsePower();
  }

  private parsePower(): Fraction {
    const base = this.parsePrimary();
    this.skipSpace();
    const character = this.peek();
    let exponentMarker = false;
    if (character === "^") {
      this.position += 1;
      exponentMarker = true;
    } else if (character === "*" && this.input[this.position + 1] === "*") {
      this.position += 2;
      exponentMarker = true;
    }
    if (!exponentMarker) {
      return base;
    }
    const exponent = this.parseUnary();
    return powerFraction(base, exponent);
  }

  private parsePrimary(): Fraction {
    this.skipSpace();
    if (this.position >= this.input.length) {
      throw new Error("the expression ends too soon");
    }
    const character = this.peek();
    if (character === "(") {
      this.position += 1;
      const value = this.parseAdditive();
      this.skipSpace();
      if (this.position >= this.input.length) {
        throw new Error('expected ")" before the end');
      }
      if (this.peek() !== ")") {
        throw new Error(this.unexpected());
      }
      this.position += 1;
      return value;
    }
    if (isDigit(character) || character === ".") {
      return this.parseNumber();
    }
    if (isLetter(character)) {
      return this.parseFunctionCall();
    }
    throw new Error(this.unexpected());
  }

  private readDigits(): string {
    let digits = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position];
      if (character === "_") {
        this.position += 1;
        continue;
      }
      if (isDigit(character)) {
        digits += character;
        this.position += 1;
        continue;
      }
      break;
    }
    return digits;
  }

  private parseNumber(): Fraction {
    const prefix = this.peek() === "0" ? this.input[this.position + 1] : undefined;
    if (
      prefix === "x" ||
      prefix === "X" ||
      prefix === "b" ||
      prefix === "B" ||
      prefix === "o" ||
      prefix === "O"
    ) {
      return this.parseRadix(prefix.toLowerCase());
    }
    const start = this.position;
    const integerDigits = this.readDigits();
    const fractionDigits = this.readFractionDigits();
    if (integerDigits.length === 0 && fractionDigits.length === 0) {
      throw new Error(this.unexpected());
    }
    const exponent = this.readExponent();
    if (Math.abs(exponent) > MAX_LITERAL_EXPONENT) {
      throw new Error(`exponent too big: ${this.input.slice(start, this.position)}`);
    }
    return decimalFraction(integerDigits + fractionDigits, exponent - fractionDigits.length);
  }

  private readFractionDigits(): string {
    if (this.peek() !== ".") {
      return "";
    }
    const dotPosition = this.position;
    this.position += 1;
    const digits = this.readDigits();
    if (digits.length === 0) {
      throw new Error(`can't read "${this.input.slice(dotPosition)}" at ${dotPosition}`);
    }
    return digits;
  }

  private readExponent(): number {
    const marker = this.peek();
    if (marker !== "e" && marker !== "E") {
      return 0;
    }
    let cursor = this.position + 1;
    let sign = 1;
    const signCharacter = this.input[cursor];
    if (signCharacter === "+" || signCharacter === "-") {
      if (signCharacter === "-") {
        sign = -1;
      }
      cursor += 1;
    }
    let digits = "";
    while (cursor < this.input.length && isDigit(this.input[cursor])) {
      digits += this.input[cursor];
      cursor += 1;
    }
    if (digits.length === 0) {
      return 0;
    }
    this.position = cursor;
    return sign * Number(digits);
  }

  private parseRadix(prefix: string): Fraction {
    const start = this.position;
    this.position += 2;
    let digits = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position];
      if (character === "_") {
        this.position += 1;
        continue;
      }
      if (isRadixDigit(character, prefix)) {
        digits += character;
        this.position += 1;
        continue;
      }
      break;
    }
    if (digits.length === 0) {
      this.position = start + 1;
      throw new Error(this.unexpected());
    }
    if (prefix === "x") {
      return fractionFromInt(BigInt(`0x${digits}`));
    }
    if (prefix === "b") {
      return fractionFromInt(BigInt(`0b${digits}`));
    }
    return fractionFromInt(BigInt(`0o${digits}`));
  }

  private parseFunctionCall(): Fraction {
    const start = this.position;
    while (this.position < this.input.length && isIdentifierChar(this.input[this.position])) {
      this.position += 1;
    }
    const name = this.input.slice(start, this.position).toLowerCase();
    this.skipSpace();
    if (this.peek() !== "(") {
      throw new Error(`no function ${name}: ${FUNCTION_LIST}`);
    }
    this.position += 1;
    this.skipSpace();
    if (this.peek() === ")") {
      throw new Error('unexpected ")"');
    }
    const args: Fraction[] = [];
    for (;;) {
      args.push(this.parseAdditive());
      this.skipSpace();
      if (this.peek() === ",") {
        this.position += 1;
        this.skipSpace();
        continue;
      }
      break;
    }
    if (this.position >= this.input.length) {
      throw new Error('expected ")" before the end');
    }
    if (this.peek() !== ")") {
      throw new Error(this.unexpected());
    }
    this.position += 1;
    return applyNamedFunction(name, args);
  }
}

function decimalFraction(digits: string, scale: number): Fraction {
  const mantissa = BigInt(digits);
  if (scale >= 0) {
    return fraction(mantissa * pow10(scale), 1n);
  }
  return fraction(mantissa, pow10(-scale));
}

function isRadixDigit(character: string, prefix: string): boolean {
  if (prefix === "x") {
    return (
      (character >= "0" && character <= "9") ||
      (character >= "a" && character <= "f") ||
      (character >= "A" && character <= "F")
    );
  }
  if (prefix === "b") {
    return character === "0" || character === "1";
  }
  return character >= "0" && character <= "7";
}

function powerFraction(base: Fraction, exponent: Fraction): Fraction {
  if (exponent.den !== 1n) {
    throw new Error(
      "a power must be a whole number: this answers exactly, and x^(1/2) mostly isn't",
    );
  }
  const negativeExponent = exponent.num < 0n;
  const magnitude = bigintAbs(exponent.num);
  if (magnitude > BigInt(MAX_POWER_EXPONENT)) {
    throw new Error("a power past 100000 is too big to write out");
  }
  if (negativeExponent && base.num === 0n) {
    throw new Error("division by zero");
  }
  const numerator = base.num ** magnitude;
  const denominator = base.den ** magnitude;
  if (negativeExponent) {
    return fraction(denominator, numerator);
  }
  return fraction(numerator, denominator);
}

function evaluateExpression(expression: string): Fraction {
  return new ExpressionParser(expression).parse();
}

interface EvalOutput {
  exact: string;
  decimal: string;
  rounded?: string;
}

/**
 * Evaluate an arithmetic expression exactly and render it as JSON.
 */
export function calcEval(expression: string, places?: number): string {
  try {
    const value = evaluateExpression(expression);
    const digits = normalizePlaces(places);
    const rendered = formatFractionDecimal(value, digits);
    const output: EvalOutput = { exact: formatFraction(value), decimal: rendered.decimal };
    if (rendered.rounded) {
      output.rounded = `to ${digits} places`;
    }
    return JSON.stringify(output);
  } catch (error) {
    return errorJson(error);
  }
}

interface LinearUnit {
  readonly category: string;
  readonly factor: Fraction;
}

interface TemperatureUnit {
  readonly scale: Fraction;
  readonly offset: Fraction;
}

interface ConvertOutput {
  exact: string;
  decimal: string;
  rounded?: string;
  unit: string;
}

const UNIT_TABLE =
  "bit bits B byte bytes kB KB KiB kb Kb kbit MB MiB Mb Mbit GB GiB Gb Gbit TB TiB Tb Tbit PB PiB Pb Pbit EB EiB Eb Ebit " +
  "ns us µs ms s sec second seconds min minute minutes h hr hour hours d day days wk week weeks " +
  "nm um µm mm cm m km in inch ft foot feet yd mi mile nmi px pt pc in-css " +
  "mg g kg t oz lb " +
  "deg turn grad " +
  "C F K";

const DATA_UNITS: Record<string, Fraction> = {
  bit: fractionFromInt(1n),
  bits: fractionFromInt(1n),
  B: fractionFromInt(8n),
  byte: fractionFromInt(8n),
  bytes: fractionFromInt(8n),
  kB: fractionFromInt(8000n),
  KB: fractionFromInt(8000n),
  KiB: fractionFromInt(8192n),
  kb: fractionFromInt(1000n),
  Kb: fractionFromInt(1000n),
  kbit: fractionFromInt(1000n),
  MB: fractionFromInt(8000000n),
  MiB: fractionFromInt(8n * 1024n * 1024n),
  Mb: fractionFromInt(1000000n),
  Mbit: fractionFromInt(1000000n),
  GB: fractionFromInt(8000000000n),
  GiB: fractionFromInt(8n * 1024n * 1024n * 1024n),
  Gb: fractionFromInt(1000000000n),
  Gbit: fractionFromInt(1000000000n),
  TB: fractionFromInt(8000000000000n),
  TiB: fractionFromInt(8n * 1024n * 1024n * 1024n * 1024n),
  Tb: fractionFromInt(1000000000000n),
  Tbit: fractionFromInt(1000000000000n),
  PB: fractionFromInt(8000000000000000n),
  PiB: fractionFromInt(8n * 1024n * 1024n * 1024n * 1024n * 1024n),
  Pb: fractionFromInt(1000000000000000n),
  Pbit: fractionFromInt(1000000000000000n),
  EB: fractionFromInt(8000000000000000000n),
  EiB: fractionFromInt(8n * 1024n * 1024n * 1024n * 1024n * 1024n * 1024n),
  Eb: fractionFromInt(1000000000000000000n),
  Ebit: fractionFromInt(1000000000000000000n),
};

const TIME_UNITS: Record<string, Fraction> = {
  ns: fraction(1n, 1000000000n),
  us: fraction(1n, 1000000n),
  µs: fraction(1n, 1000000n),
  ms: fraction(1n, 1000n),
  s: fractionFromInt(1n),
  sec: fractionFromInt(1n),
  second: fractionFromInt(1n),
  seconds: fractionFromInt(1n),
  min: fractionFromInt(60n),
  minute: fractionFromInt(60n),
  minutes: fractionFromInt(60n),
  h: fractionFromInt(3600n),
  hr: fractionFromInt(3600n),
  hour: fractionFromInt(3600n),
  hours: fractionFromInt(3600n),
  d: fractionFromInt(86400n),
  day: fractionFromInt(86400n),
  days: fractionFromInt(86400n),
  wk: fractionFromInt(604800n),
  week: fractionFromInt(604800n),
  weeks: fractionFromInt(604800n),
};

const LENGTH_UNITS: Record<string, Fraction> = {
  nm: fraction(1n, 1000000000n),
  um: fraction(1n, 1000000n),
  µm: fraction(1n, 1000000n),
  mm: fraction(1n, 1000n),
  cm: fraction(1n, 100n),
  m: fractionFromInt(1n),
  km: fractionFromInt(1000n),
  in: fraction(127n, 5000n),
  inch: fraction(127n, 5000n),
  ft: fraction(381n, 1250n),
  foot: fraction(381n, 1250n),
  feet: fraction(381n, 1250n),
  yd: fraction(1143n, 1250n),
  mi: fraction(201168n, 125n),
  mile: fraction(201168n, 125n),
  nmi: fractionFromInt(1852n),
  px: fraction(127n, 480000n),
  pt: fraction(127n, 360000n),
  pc: fraction(127n, 30000n),
  "in-css": fraction(127n, 5000n),
};

const MASS_UNITS: Record<string, Fraction> = {
  mg: fraction(1n, 1000n),
  g: fractionFromInt(1n),
  kg: fractionFromInt(1000n),
  t: fractionFromInt(1000000n),
  oz: fraction(226796185n, 8000000n),
  lb: fraction(45359237n, 100000n),
};

const ANGLE_UNITS: Record<string, Fraction> = {
  deg: fractionFromInt(1n),
  turn: fractionFromInt(360n),
  grad: fraction(9n, 10n),
};

const LINEAR_UNITS: Record<string, LinearUnit> = buildLinearUnits();

const TEMPERATURE_UNITS: Record<string, TemperatureUnit> = {
  C: { scale: fractionFromInt(1n), offset: fraction(5463n, 20n) },
  K: { scale: fractionFromInt(1n), offset: fractionFromInt(0n) },
  F: { scale: fraction(5n, 9n), offset: fraction(45967n, 180n) },
};

function buildLinearUnits(): Record<string, LinearUnit> {
  const units: Record<string, LinearUnit> = {};
  for (const [name, factor] of Object.entries(DATA_UNITS)) {
    units[name] = { category: "data", factor };
  }
  for (const [name, factor] of Object.entries(TIME_UNITS)) {
    units[name] = { category: "time", factor };
  }
  for (const [name, factor] of Object.entries(LENGTH_UNITS)) {
    units[name] = { category: "length", factor };
  }
  for (const [name, factor] of Object.entries(MASS_UNITS)) {
    units[name] = { category: "mass", factor };
  }
  for (const [name, factor] of Object.entries(ANGLE_UNITS)) {
    units[name] = { category: "angle", factor };
  }
  return units;
}

/**
 * Convert between units. `value` may itself be an exact arithmetic expression.
 */
export function calcConvert(value: string, from: string, to: string, places?: number): string {
  try {
    const source: LinearUnit | undefined = LINEAR_UNITS[from];
    const target: LinearUnit | undefined = LINEAR_UNITS[to];
    if (source === undefined) {
      const temperature: TemperatureUnit | undefined = TEMPERATURE_UNITS[from];
      if (temperature === undefined) {
        throw new Error(`no unit ${from}: ${UNIT_TABLE}`);
      }
    }
    if (target === undefined) {
      const temperature: TemperatureUnit | undefined = TEMPERATURE_UNITS[to];
      if (temperature === undefined) {
        throw new Error(`no unit ${to}: ${UNIT_TABLE}`);
      }
    }
    const amount = evaluateExpression(value);
    const converted = convertAmount(amount, from, to, source, target);
    const digits = normalizePlaces(places);
    const rendered = formatFractionDecimal(converted, digits);
    const output: ConvertOutput = {
      exact: formatFraction(converted),
      decimal: rendered.decimal,
      ...(rendered.rounded ? { rounded: `to ${digits} places` } : {}),
      unit: to,
    };
    return JSON.stringify(output);
  } catch (error) {
    return errorJson(error);
  }
}

function convertAmount(
  amount: Fraction,
  from: string,
  to: string,
  source: LinearUnit | undefined,
  target: LinearUnit | undefined,
): Fraction {
  const sourceTemperature: TemperatureUnit | undefined = TEMPERATURE_UNITS[from];
  const targetTemperature: TemperatureUnit | undefined = TEMPERATURE_UNITS[to];
  if (sourceTemperature !== undefined && targetTemperature !== undefined) {
    const kelvin = addFractions(
      multiplyFractions(sourceTemperature.scale, amount),
      sourceTemperature.offset,
    );
    return divideFractions(
      subtractFractions(kelvin, targetTemperature.offset),
      targetTemperature.scale,
    );
  }
  if (sourceTemperature !== undefined) {
    throw new Error(`can't convert ${from} to ${to}`);
  }
  if (targetTemperature !== undefined) {
    throw new Error(`can't convert ${from} to ${to}`);
  }
  if (source === undefined || target === undefined) {
    throw new Error(`no unit ${source === undefined ? from : to}: ${UNIT_TABLE}`);
  }
  if (source.category !== target.category) {
    throw new Error(`${from} is ${source.category} and ${to} is ${target.category}`);
  }
  return divideFractions(multiplyFractions(amount, source.factor), target.factor);
}

export interface CalcDateInput {
  date?: string;
  add?: string;
  to?: string;
  timeZone?: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

interface DateFields {
  iso: string;
  local?: string;
  timeZone?: string;
  weekday: string;
  unix: number;
  unixMs: number;
  dayOfYear: number;
  isoWeek: string;
}

interface BetweenFields {
  calendar: string;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
}

interface DateOutput extends DateFields {
  to?: DateFields;
  between?: BetweenFields;
}

interface DurationParts {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validateTimeZone(timeZone: string): void {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone });
    formatter.format(new Date(0));
  } catch {
    throw new Error(
      `no time zone ${timeZone}: an IANA name such as Europe/Berlin or Asia/Shanghai`,
    );
  }
}

function partsInZone(ms: number, timeZone: string | undefined): DateParts {
  const subSecond = ((ms % 1000) + 1000) % 1000;
  if (timeZone === undefined) {
    const date = new Date(ms);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      ms: date.getUTCMilliseconds(),
    };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") {
      found[part.type] = part.value;
    }
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour: Number(found.hour),
    minute: Number(found.minute),
    second: Number(found.second),
    ms: subSecond,
  };
}

function wallSerial(parts: DateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.ms,
  );
}

function offsetAt(ms: number, timeZone: string): number {
  return wallSerial(partsInZone(ms, timeZone)) - ms;
}

function wallToInstant(parts: DateParts, timeZone: string): number {
  const wall = wallSerial(parts);
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wall - offsetAt(guess, timeZone);
    if (next === guess) {
      break;
    }
    guess = next;
  }
  return guess;
}

function numericDateValue(trimmed: string): number | undefined {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Math.abs(numeric) >= 100000000000) {
    return Math.round(numeric);
  }
  return Math.round(numeric * 1000);
}

function partOrZero(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

function partsFromMatch(match: RegExpExecArray, input: string): DateParts {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`no such date: ${input}`);
  }
  const hour = partOrZero(match[4]);
  const minute = partOrZero(match[5]);
  const second = partOrZero(match[6]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`no such date: ${input}`);
  }
  const fractionPart = match[7] ?? "";
  const ms = fractionPart.length === 0 ? 0 : Number(fractionPart.padEnd(3, "0").slice(0, 3));
  return { year, month, day, hour, minute, second, ms };
}

function offsetFromMatch(match: RegExpExecArray): number | undefined {
  if (match[9] === undefined) {
    return undefined;
  }
  const sign = match[9] === "-" ? -1 : 1;
  return sign * (Number(match[10]) * 60 + Number(match[11])) * 60000;
}

function parseDateInput(input: string | undefined, timeZone: string | undefined): number {
  if (input === undefined || input.trim().toLowerCase() === "now") {
    return Date.now();
  }
  const trimmed = input.trim();
  const numeric = numericDateValue(trimmed);
  if (numeric !== undefined) {
    return numeric;
  }
  const match = DATE_PATTERN.exec(trimmed);
  if (match === null) {
    throw new Error(`not a date: ${input} (ISO 8601, unix seconds or ms, or "now")`);
  }
  const parts = partsFromMatch(match, input);
  if (match[8] !== undefined) {
    return wallSerial(parts);
  }
  const offset = offsetFromMatch(match);
  if (offset !== undefined) {
    return wallSerial(parts) - offset;
  }
  if (timeZone !== undefined) {
    return wallToInstant(parts, timeZone);
  }
  return wallSerial(parts);
}

interface DurationUnit {
  readonly field: keyof DurationParts;
  readonly multiplier: number;
}

const DURATION_UNITS: Record<string, DurationUnit> = {
  y: { field: "years", multiplier: 1 },
  year: { field: "years", multiplier: 1 },
  years: { field: "years", multiplier: 1 },
  mo: { field: "months", multiplier: 1 },
  month: { field: "months", multiplier: 1 },
  months: { field: "months", multiplier: 1 },
  w: { field: "days", multiplier: 7 },
  wk: { field: "days", multiplier: 7 },
  week: { field: "days", multiplier: 7 },
  weeks: { field: "days", multiplier: 7 },
  d: { field: "days", multiplier: 1 },
  day: { field: "days", multiplier: 1 },
  days: { field: "days", multiplier: 1 },
  h: { field: "hours", multiplier: 1 },
  hr: { field: "hours", multiplier: 1 },
  hour: { field: "hours", multiplier: 1 },
  hours: { field: "hours", multiplier: 1 },
  m: { field: "minutes", multiplier: 1 },
  min: { field: "minutes", multiplier: 1 },
  minute: { field: "minutes", multiplier: 1 },
  minutes: { field: "minutes", multiplier: 1 },
  s: { field: "seconds", multiplier: 1 },
  sec: { field: "seconds", multiplier: 1 },
  second: { field: "seconds", multiplier: 1 },
  seconds: { field: "seconds", multiplier: 1 },
  ms: { field: "ms", multiplier: 1 },
  millisecond: { field: "ms", multiplier: 1 },
  milliseconds: { field: "ms", multiplier: 1 },
};

function emptyDuration(): DurationParts {
  return { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0, ms: 0 };
}

function durationError(input: string): Error {
  return new Error(`not a duration: ${input} (like "3d 4h", "-90m", "1y2mo" or "P1DT2H")`);
}

function parseDuration(input: string): DurationParts {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return emptyDuration();
  }
  const negative = trimmed.startsWith("-");
  const body = trimmed.replace(/^[+-]/, "");
  const sign = negative ? -1 : 1;
  if (body.startsWith("P") || body.startsWith("p")) {
    return parseIsoDuration(trimmed, body, sign);
  }
  return parseCompactDuration(trimmed, body, sign);
}

function parseIsoDuration(original: string, body: string, sign: number): DurationParts {
  const pattern =
    /^[Pp](?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
  const match = pattern.exec(body);
  if (match === null || match.slice(1).every((part) => part === undefined)) {
    throw durationError(original);
  }
  const years = match[1] === undefined ? 0 : Number(match[1]);
  const months = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(years) || !Number.isInteger(months)) {
    throw new Error(`${original}: years and months are whole`);
  }
  const weeks = match[3] === undefined ? 0 : Number(match[3]);
  const days = match[4] === undefined ? 0 : Number(match[4]);
  const hours = match[5] === undefined ? 0 : Number(match[5]);
  const minutes = match[6] === undefined ? 0 : Number(match[6]);
  const seconds = match[7] === undefined ? 0 : Number(match[7]);
  return {
    years: sign * years,
    months: sign * months,
    days: sign * (days + weeks * 7),
    hours: sign * hours,
    minutes: sign * minutes,
    seconds: sign * seconds,
    ms: 0,
  };
}

function parseCompactDuration(original: string, body: string, sign: number): DurationParts {
  const result = emptyDuration();
  const pattern = /(\d+(?:\.\d+)?)\s*([A-Za-z]+)/y;
  let position = 0;
  let sawComponent = false;
  while (position < body.length) {
    const character = body[position];
    if (character === " " || character === "\t") {
      position += 1;
      continue;
    }
    pattern.lastIndex = position;
    const match = pattern.exec(body);
    if (match === null) {
      throw durationError(original);
    }
    sawComponent = true;
    position = pattern.lastIndex;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "us") {
      throw new Error("no duration unit us: y mo w d h m s ms");
    }
    const target: DurationUnit | undefined = DURATION_UNITS[unit];
    if (target === undefined) {
      throw new Error(`no duration unit ${unit}: y mo w d h m s ms`);
    }
    if ((target.field === "years" || target.field === "months") && !Number.isInteger(amount)) {
      throw new Error(`${original}: years and months are whole`);
    }
    result[target.field] += sign * amount * target.multiplier;
  }
  if (!sawComponent) {
    throw durationError(original);
  }
  return result;
}

function addDuration(ms: number, duration: DurationParts, timeZone: string | undefined): number {
  const totalMonths = duration.years * 12 + duration.months;
  const parts = partsInZone(ms, timeZone);
  const monthIndex = parts.month - 1 + totalMonths;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  const wholeDays = Math.trunc(duration.days);
  const fractionalDays = duration.days - wholeDays;
  const movedDate = new Date(Date.UTC(year, month - 1, day) + wholeDays * 86400000);
  const calendarParts: DateParts = {
    year: movedDate.getUTCFullYear(),
    month: movedDate.getUTCMonth() + 1,
    day: movedDate.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    ms: parts.ms,
  };
  const calendarInstant =
    timeZone === undefined ? wallSerial(calendarParts) : wallToInstant(calendarParts, timeZone);
  return (
    calendarInstant +
    fractionalDays * 86400000 +
    duration.hours * 3600000 +
    duration.minutes * 60000 +
    duration.seconds * 1000 +
    duration.ms
  );
}

function shiftMonths(parts: DateParts, months: number): DateParts {
  const monthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { ...parts, year, month, day };
}

function betweenInstants(start: number, end: number, timeZone: string | undefined): BetweenFields {
  const sign = end >= start ? 1 : -1;
  const earlier = Math.min(start, end);
  const later = Math.max(start, end);
  const earlierParts = partsInZone(earlier, timeZone);
  const laterParts = partsInZone(later, timeZone);
  let months = (laterParts.year - earlierParts.year) * 12 + (laterParts.month - earlierParts.month);
  let cursor = shiftMonths(earlierParts, months);
  if (wallSerial(cursor) > wallSerial(laterParts)) {
    months -= 1;
    cursor = shiftMonths(earlierParts, months);
  }
  const years = Math.trunc(months / 12);
  const remainingMonths = months - years * 12;
  let remainder = wallSerial(laterParts) - wallSerial(cursor);
  const days = Math.floor(remainder / 86400000);
  remainder -= days * 86400000;
  const hours = Math.floor(remainder / 3600000);
  remainder -= hours * 3600000;
  const minutes = Math.floor(remainder / 60000);
  remainder -= minutes * 60000;
  const seconds = Math.floor(remainder / 1000);
  const ms = remainder - seconds * 1000;
  const components: string[] = [];
  if (years !== 0) {
    components.push(`${years}y`);
  }
  if (remainingMonths !== 0) {
    components.push(`${remainingMonths}mo`);
  }
  if (days !== 0) {
    components.push(`${days}d`);
  }
  if (hours !== 0) {
    components.push(`${hours}h`);
  }
  if (minutes !== 0) {
    components.push(`${minutes}m`);
  }
  if (seconds !== 0) {
    components.push(`${seconds}s`);
  }
  if (ms !== 0) {
    components.push(`${ms}ms`);
  }
  let calendar = components.length === 0 ? "0s" : components.join(" ");
  if (sign < 0 && components.length > 0) {
    calendar = `-${calendar}`;
  }
  const difference = end - start;
  return {
    calendar,
    days: difference / 86400000,
    hours: difference / 3600000,
    minutes: difference / 60000,
    seconds: difference / 1000,
    ms: difference,
  };
}

function isoWeekOf(parts: DateParts): string {
  const dateSerial = Date.UTC(parts.year, parts.month - 1, parts.day);
  const weekday = (new Date(dateSerial).getUTCDay() + 6) % 7;
  const thursday = dateSerial + (3 - weekday) * 86400000;
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / 86400000 / 7) + 1;
  return `${isoYear}-W${pad(week, 2)}`;
}

function dayOfYearOf(parts: DateParts): number {
  return (
    Math.floor(
      (Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(parts.year, 0, 1)) / 86400000,
    ) + 1
  );
}

function formatLocal(parts: DateParts, ms: number): string {
  const offset = wallSerial(parts) - ms;
  const sign = offset < 0 ? "-" : "+";
  const totalMinutes = Math.round(Math.abs(offset) / 60000);
  const offsetHours = Math.floor(totalMinutes / 60);
  const offsetMinutes = totalMinutes % 60;
  const msPart = parts.ms === 0 ? "" : `.${pad(parts.ms, 3)}`;
  return (
    `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}` +
    `T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}${msPart}` +
    `${sign}${pad(offsetHours, 2)}:${pad(offsetMinutes, 2)}`
  );
}

function buildDateFields(ms: number, timeZone: string | undefined): DateFields {
  const parts = partsInZone(ms, timeZone);
  const local = timeZone === undefined ? undefined : formatLocal(parts, ms);
  return {
    iso: new Date(ms).toISOString(),
    ...(local === undefined ? {} : { local, timeZone }),
    weekday: WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()],
    unix: Math.floor(ms / 1000),
    unixMs: ms,
    dayOfYear: dayOfYearOf(parts),
    isoWeek: isoWeekOf(parts),
  };
}

/**
 * Parse, shift and compare dates, returning JSON with ISO, weekday and ISO week fields.
 */
export function calcDate(input: CalcDateInput): string {
  try {
    if (input.timeZone !== undefined) {
      validateTimeZone(input.timeZone);
    }
    let instant = parseDateInput(input.date, input.timeZone);
    if (input.add !== undefined && input.add.trim().length > 0) {
      instant = addDuration(instant, parseDuration(input.add), input.timeZone);
    }
    const fields = buildDateFields(instant, input.timeZone);
    if (input.to === undefined) {
      return JSON.stringify(fields);
    }
    const target = parseDateInput(input.to, input.timeZone);
    const output: DateOutput = { ...fields };
    output.to = buildDateFields(target, input.timeZone);
    output.between = betweenInstants(instant, target, input.timeZone);
    return JSON.stringify(output);
  } catch (error) {
    return errorJson(error);
  }
}
