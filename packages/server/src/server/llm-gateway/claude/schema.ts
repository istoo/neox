import Ajv, { type ValidateFunction } from "ajv";
import type { ClaudeToolSpec } from "./tools.js";

/** The tool a request with a JSON schema is answered through, unless a client's tool has the name. */
export const ANSWER_TOOL = "StructuredOutput";

export const ANSWER_TOOL_DESCRIPTION =
  "Use this tool to give your final answer, as its input, in the shape its input schema asks. Call it once, at the end of your work, instead of answering in words.";

export interface ClaudeAnswer {
  name: string;
  spec: ClaudeToolSpec;
  /** Why a call's input doesn't fit, null when it does. */
  validate(argumentsJson: string): string | null;
}

/**
 * Claude Code's interactive mode takes `--json-schema` and does nothing with
 * it; a run with a schema is given an answer tool through the bridge's MCP
 * server instead, as myna's claude_tui_schema.go does. Its input schema is
 * the caller's, checked against every call.
 */
export function claudeAnswer(tools: readonly ClaudeToolSpec[], schema: unknown): ClaudeAnswer {
  const validate = compileClaudeAnswerSchema(schema);
  let name = ANSWER_TOOL;
  for (let n = 2; tools.some((tool) => tool.name === name); n += 1) {
    name = `${ANSWER_TOOL}${n}`;
  }
  return {
    name,
    spec: {
      name,
      description: ANSWER_TOOL_DESCRIPTION,
      inputSchema: schema,
    },
    validate: (argumentsJson: string): string | null => {
      let input: unknown;
      try {
        input = JSON.parse(argumentsJson);
      } catch {
        return "the input isn't JSON";
      }
      if (validate(input)) {
        return null;
      }
      return describeErrors(validate.errors);
    },
  };
}

/** The words a turn that ended without its answer tool's call is asked with. */
export function answerAsk(name: string): string {
  return `Give your final answer now by calling the ${name} tool, with the answer as its input.`;
}

/**
 * A caller's schema compiled to check the answer tool's calls against. A
 * schema that names anything outside itself is refused: nothing a caller
 * writes is fetched or read.
 */
export function compileClaudeAnswerSchema(schema: unknown): ValidateFunction {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("the JSON schema isn't an object");
  }
  // ajv's typings don't see its class under this module setting; the
  // provider's response loop imports it the same way.
  const AjvConstructor = Ajv as unknown as new (options: Record<string, unknown>) => {
    compile(schema: unknown): ValidateFunction;
  };
  const ajv = new AjvConstructor({ strict: false, validateSchema: true, allErrors: true });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`the JSON schema can't be used: ${errorText(error)}`, { cause: error });
  }
  return validate;
}

function describeErrors(errors: ValidateFunction["errors"]): string {
  if (errors === null || errors === undefined) {
    return "the input doesn't fit the schema";
  }
  return errors
    .map(
      (error) =>
        `${error.instancePath === "" ? "the answer" : error.instancePath} ${error.message ?? "doesn't fit"}`,
    )
    .join("; ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
