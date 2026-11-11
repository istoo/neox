import { cpSync, mkdirSync } from "node:fs";

const target = "dist/server/server/llm-gateway/browser-extension";
mkdirSync(target, { recursive: true });
cpSync("src/server/llm-gateway/browser-extension", target, { recursive: true });
