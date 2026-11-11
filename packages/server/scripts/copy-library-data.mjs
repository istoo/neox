import { cpSync, mkdirSync } from "node:fs";

const target = "dist/server/server/library/data";
mkdirSync(target, { recursive: true });
cpSync("src/server/library/data", target, { recursive: true });

// The Claude subscription bridge's MCP helper runs as plain JavaScript beside
// the compiled server, whatever the daemon's build.
const claudeTarget = "dist/server/server/llm-gateway/claude";
mkdirSync(claudeTarget, { recursive: true });
cpSync("src/server/llm-gateway/claude/mcp-helper.mjs", `${claudeTarget}/mcp-helper.mjs`);
cpSync("assets/claude/tap.cjs", `${claudeTarget}/tap.cjs`);
