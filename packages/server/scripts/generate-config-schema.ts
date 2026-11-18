import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { z } from "zod";
import { PersistedConfigSchema } from "../src/server/persisted-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const outPath = path.join(repoRoot, "schemas/neox.config.v1.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const schema = z.toJSONSchema(PersistedConfigSchema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  });
  schema.title = "NeolixConfigV1";

  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  // Keep the committed file in the repository's formatter style so a
  // regeneration does not leave `format:check` dirty.
  const formatted = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "format:files", "--", outPath],
    { cwd: repoRoot, stdio: "ignore" },
  );
  if (formatted.status !== 0) {
    process.stderr.write(`Could not format ${outPath}; run npm run format\n`);
  }
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
