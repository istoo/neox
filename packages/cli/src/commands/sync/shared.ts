import type { SingleResult } from "../../output/index.js";
import type { CommandOptions } from "../../output/index.js";

/** The home this command reads and writes; only a local instance has one. */
export function localHome(options: CommandOptions): string {
  const target = options.daemonTarget;
  if (!target || target.kind !== "instance") {
    throw new Error("This command reads this computer's files: drop --host");
  }
  return target.home;
}

/** One result whose human form is a myna-style block of lines. */
export function textResult(
  text: string,
  data: Record<string, unknown>,
): SingleResult<Record<string, unknown>> {
  return {
    type: "single",
    data,
    schema: {
      idField: () => "",
      columns: [],
      renderHuman: () => text,
      serialize: () => data,
    },
  };
}
