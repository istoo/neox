#!/usr/bin/env npx tsx

import assert from "node:assert";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { runLocalNeolix } from "./helpers/local-cli.ts";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

console.log("=== Onboarding Command ===\n");

const neolixHome = await mkdtemp(join(tmpdir(), "neolix-onboard-home-"));
const port = await getAvailablePort();

try {
  const configured = await runLocalNeolix([
    "daemon",
    "config",
    "set",
    "daemon.listen",
    `127.0.0.1:${port}`,
    "--home",
    neolixHome,
  ]);
  assert.strictEqual(configured.exitCode, 0, configured.stderr);

  // The product ships no default relay service or app address, and a pairing
  // offer needs both, so give the fixture a relay to offer.
  for (const [key, value] of [
    ["daemon.relay.endpoint", "relay.example.com:443"],
    ["app.baseUrl", "https://app.example.com"],
  ] as const) {
    const result = await runLocalNeolix([
      "daemon",
      "config",
      "set",
      key,
      value,
      "--home",
      neolixHome,
    ]);
    assert.strictEqual(result.exitCode, 0, result.stderr);
  }

  console.log("Test 1: bare `Neox` falls back to onboarding when the app is not installed");
  const onboard =
    await $`NEOLIX_HOME=${neolixHome} NEOLIX_PAIRING_QR=0 NEOLIX_NO_DESKTOP=1 npx neox`.nothrow();

  assert.strictEqual(
    onboard.exitCode,
    0,
    `onboard should succeed:\nstdout:\n${onboard.stdout}\nstderr:\n${onboard.stderr}`,
  );
  assert(!onboard.stdout.includes("Scan to pair"), "onboard output should not include scan header");
  assert(!onboard.stdout.includes("#offer="), "onboard output should not include a pairing offer");
  assert(
    onboard.stdout.includes("Daemon is running with relay off"),
    "onboard output should explain the direct connection path",
  );
  assert(
    onboard.stdout.includes("CLI quick reference"),
    "onboard output should include CLI quick reference",
  );
  assert(onboard.stdout.includes("neox --help"), "onboard output should include --help shortcut");
  assert(onboard.stdout.includes("neox ls"), "onboard output should include ls shortcut");
  assert(
    onboard.stdout.includes(`neox run --home ${JSON.stringify(neolixHome)} "your prompt"`),
    "onboard output should include a run shortcut for the selected home",
  );
  assert(onboard.stdout.includes("neox status"), "onboard output should include status shortcut");
  assert(
    onboard.stdout.includes(join(neolixHome, "daemon.log")),
    "onboard output should include daemon log path",
  );

  const status =
    await $`NEOLIX_HOME=${neolixHome} npx neox daemon status --home ${neolixHome}`.nothrow();
  assert.strictEqual(status.exitCode, 0, `daemon status should succeed: ${status.stderr}`);
  assert(status.stdout.includes("running"), "daemon should be running when onboarding exits");
  console.log("✓ onboarding keeps relay disabled and waits for daemon readiness\n");

  console.log("Test 2: bare `Neox` falls back to onboarding without a graphical session");
  const headless =
    await $`SSH_CONNECTION="10.0.0.1 22 10.0.0.2 22" NEOLIX_HOME=${neolixHome} NEOLIX_PAIRING_QR=0 npx neox`.nothrow();
  assert.strictEqual(
    headless.exitCode,
    0,
    `headless onboarding should succeed:\nstdout:\n${headless.stdout}\nstderr:\n${headless.stderr}`,
  );
  assert(
    headless.stdout.includes("CLI quick reference"),
    "a headless login should run onboarding instead of opening the app",
  );
  assert(
    !headless.stdout.includes("#offer="),
    "headless onboarding should not include a pairing offer",
  );
  console.log("✓ SSH logins stay on the onboarding path\n");

  console.log("Test 3: --no-relay suppresses pairing for an already-running daemon");
  const enableRelay =
    await $`NEOLIX_HOME=${neolixHome} npx neox daemon pair --home ${neolixHome} --relay`.nothrow();
  assert.strictEqual(enableRelay.exitCode, 0, `relay enable should succeed: ${enableRelay.stderr}`);
  assert(enableRelay.stdout.includes("#offer="), "relay enable should produce a pairing offer");

  const noRelayOnboard =
    await $`NEOLIX_HOME=${neolixHome} NEOLIX_NO_DESKTOP=1 npx neox --no-relay`.nothrow();
  assert.strictEqual(
    noRelayOnboard.exitCode,
    0,
    `--no-relay onboarding should succeed: ${noRelayOnboard.stderr}`,
  );
  assert(
    !noRelayOnboard.stdout.includes("#offer="),
    "--no-relay onboarding should not include a pairing offer",
  );
  console.log("✓ --no-relay suppresses pairing for an already-running daemon\n");

  console.log("Test 4: non-interactive onboarding persists voice disabled config");
  const configRaw = await readFile(join(neolixHome, "config.json"), "utf-8");
  const config = JSON.parse(configRaw) as {
    features?: {
      dictation?: { enabled?: boolean };
      voiceMode?: { enabled?: boolean };
    };
  };

  assert.strictEqual(
    config.features?.dictation?.enabled,
    false,
    "dictation.enabled should be false",
  );
  assert.strictEqual(
    config.features?.voiceMode?.enabled,
    false,
    "voiceMode.enabled should be false",
  );
  const daemonLog = await readFile(join(neolixHome, "daemon.log"), "utf-8");
  assert(
    !daemonLog.includes("Ensuring local speech models"),
    "daemon should not attempt local speech model setup when voice is disabled",
  );
  console.log("✓ non-interactive run persisted voice disabled choices\n");
} finally {
  await $`NEOLIX_HOME=${neolixHome} npx neox daemon stop --home ${neolixHome} --force`.nothrow();
  await rm(neolixHome, { recursive: true, force: true });
}

console.log("=== Onboarding tests passed ===");
