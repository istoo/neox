import { access } from "node:fs/promises";

/**
 * Whether the daemon runs inside a container, as myna's Settings › Network
 * notes when its gateway is one container among others on the host. Docker
 * and Podman leave these marker files; NEOLIX_CONTAINER overrides the look.
 */
export async function isContainerRuntime(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const flag = (env.NEOLIX_CONTAINER ?? "").trim().toLowerCase();
  if (flag.length > 0) {
    return flag !== "0" && flag !== "false" && flag !== "off";
  }
  return (await exists("/.dockerenv")) || (await exists("/run/.containerenv"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
