import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));

function request(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", agent: false, timeout: 2_000 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

test("a worker restart never closes the port", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-supervisor-listener-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const addressPath = path.join(home, "address.txt");
  const markerPath = path.join(home, "first-started");
  const inherited = path.join(serverRoot, "src/server/inherited-listener.ts");
  const listenAddress = path.join(serverRoot, "src/server/listen-address.ts");
  const supervisorEntry = new URL("./supervisor.ts", import.meta.url).href;
  const listenerEntry = new URL("./supervisor-listener.ts", import.meta.url).href;

  await writeFile(
    workerPath,
    `
    import { existsSync, writeFileSync } from "node:fs";
    import { createServer } from "node:http";
    import { inheritListener } from ${JSON.stringify(inherited)};
    import { parseListenString } from ${JSON.stringify(listenAddress)};
    const server = createServer((request, response) => response.end("ok " + process.pid));
    inheritListener(server, { listenTarget: parseListenString(process.env.NEOLIX_INHERITED_LISTEN) });
    process.send({ type: "neolix:ready", listen: process.env.NEOLIX_INHERITED_LISTEN, serverId: "srv_test" });
    if (!existsSync(${JSON.stringify(markerPath)})) {
      writeFileSync(${JSON.stringify(markerPath)}, "1");
      // Ask for a restart while a request is in flight; the supervisor must keep
      // serving new connections throughout.
      setTimeout(() => process.send({ type: "neolix:restart", keepTerminals: true }), 400);
    }
    process.on("message", (message) => {
      if (message?.type !== "neolix:graceful-shutdown") return;
      // Hold the worker's HTTP server open, then end it: the supervisor's socket
      // is the only thing that can answer while this worker is going away.
      setTimeout(() => server.closeAllConnections(), 350);
      setTimeout(() => server.close(() => process.exit(0)), 400);
    });
  `,
  );
  await writeFile(
    runnerPath,
    `
    import { writeFileSync } from "node:fs";
    import { runSupervisor } from ${JSON.stringify(supervisorEntry)};
    import { createSupervisorListener } from ${JSON.stringify(listenerEntry)};
    const listener = await createSupervisorListener("127.0.0.1:0");
    writeFileSync(${JSON.stringify(addressPath)}, String(listener.address));
    runSupervisor({
      name: "ListenerTest",
      startupMessage: "starting",
      restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
      workerArgs: [],
      workerExecArgv: ["--import", "tsx"],
      workerEnv: { ...process.env, NEOLIX_INHERITED_LISTEN: listener.address },
      listener,
    });
  `,
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NEOLIX_")),
  );
  const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: serverRoot,
    env: { ...env, HOME: home, NEOLIX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  runner.stdout.on("data", (chunk) => {
    output += chunk;
  });
  runner.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const deadline = Date.now() + 15_000;
  while (!existsSync(addressPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(addressPath)) throw new Error(`supervisor did not bind:\n${output}`);
  const [host, portText] = (await readFile(addressPath, "utf8")).split(":");
  const port = Number(portText);
  expect(host).toBe("127.0.0.1");

  // Wait for the first worker, then keep one request in flight through the restart.
  let first: { status: number; body: string } | null = null;
  while (first === null && Date.now() < deadline) {
    try {
      first = await request(port);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  expect(first?.status).toBe(200);
  const firstPid = first?.body.slice(3);

  const results: string[] = [];
  let secondPid: string | null = null;
  while (Date.now() < deadline && secondPid === null) {
    try {
      const answer = await request(port);
      results.push(`${answer.status} ${answer.body}`);
      const pid = answer.body.slice(3);
      if (pid !== firstPid) secondPid = pid;
    } catch (error) {
      results.push(`error ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  runner.kill("SIGKILL");
  await new Promise<void>((resolve) => runner.once("close", () => resolve()));
  await rm(home, { recursive: true, force: true });

  expect(secondPid).not.toBeNull();
  expect(results.filter((line) => line.startsWith("error"))).toEqual([]);
  expect(results.every((line) => line.startsWith("200"))).toBe(true);
}, 30_000);
