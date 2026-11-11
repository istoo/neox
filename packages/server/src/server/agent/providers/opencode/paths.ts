import path from "node:path";

import { resolveNeolixHome } from "../../../neolix-home.js";

const OPENCODE_HOME_DIRNAME = "opencode-home";

export function resolveOpenCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveNeolixHome(env), OPENCODE_HOME_DIRNAME);
}
