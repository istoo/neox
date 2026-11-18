import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { vitestMaxWorkers } from "./vitest-max-workers.mjs";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  [
    "server-tests-macos",
    { name: "server-tests (macos-latest, file observation)", contract: "server" },
  ],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  [
    "desktop-web-tests",
    { name: "desktop-web-tests (typecheck and unit)", contract: "desktop_web" },
  ],
  ["desktop-web-browser-1", { name: "desktop-web-browser (shard 1/4)", contract: "desktop_web" }],
  ["desktop-web-browser-2", { name: "desktop-web-browser (shard 2/4)", contract: "desktop_web" }],
  ["desktop-web-browser-3", { name: "desktop-web-browser (shard 3/4)", contract: "desktop_web" }],
  ["desktop-web-browser-4", { name: "desktop-web-browser (shard 4/4)", contract: "desktop_web" }],
  [
    "desktop-web-e2e",
    { name: "desktop-web-e2e (real daemon and UI)", contract: "desktop_web_real_daemon" },
  ],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [
    ciWorkflowPath,
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
  ]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("published npm packages declare and ship the repository license", () => {
  const rootManifest = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
  const workspaceArgs = rootManifest.scripts["release:publish"].match(/--workspace=\S+/g);
  assert.notEqual(workspaceArgs, null, "release:publish must select public packages");
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", ...workspaceArgs], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const manifests = new Map(
    rootManifest.workspaces.map((workspace) => {
      const directory = new URL(`${workspace}/`, repoRoot);
      const manifest = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
      return [manifest.name, { directory, manifest }];
    }),
  );
  const licenses = packed.map(({ name, files }) => ({
    name,
    license: manifests.get(name).manifest.license,
    files: files.filter((file) => file.path === "LICENSE").map((file) => file.path),
  }));
  assert.deepEqual(
    licenses,
    workspaceArgs.map((workspace) => ({
      name: workspace.slice("--workspace=".length),
      license: "Apache-2.0",
      files: ["LICENSE"],
    })),
  );
  const repositoryLicense = readFileSync(new URL("LICENSE", repoRoot), "utf8");
  for (const { name } of packed) {
    const { directory } = manifests.get(name);
    assert.equal(readFileSync(new URL("LICENSE", directory), "utf8"), repositoryLicense, name);
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@neolix\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /npm run test --workspace=@neolix\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("desktop-web typechecks, unit tests, and every browser project run in CI", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes").join("\n");
  const unitJob = jobs.get("desktop-web-tests").join("\n");

  assert.match(changes, /^      desktop_web: \$\{\{ steps\.filter\.outputs\.desktop_web \}\}$/m);
  assert.match(unitJob, /run: node scripts\/npm-retry\.mjs ci/);
  assert.match(unitJob, /run: npm run build:server/);
  assert.match(
    unitJob,
    /working-directory: packages\/desktop-web\n        run: bun install --frozen-lockfile/,
  );
  for (const directory of [
    "packages/desktop-web/packages/contracts",
    "packages/desktop-web/packages/client-runtime",
    "packages/desktop-web/apps/bridge",
    "packages/desktop-web/apps/web",
  ]) {
    assert.match(
      unitJob,
      new RegExp(
        `working-directory: ${directory.replaceAll("/", "\\/")}\n        run: bun run typecheck`,
      ),
      `${directory} typecheck`,
    );
  }
  assert.match(
    unitJob,
    /working-directory: packages\/desktop-web\/packages\/client-runtime\n        run: bun run test/,
  );
  assert.match(
    unitJob,
    /working-directory: packages\/desktop-web\/apps\/bridge\n        run: bunx vitest run/,
  );
  assert.match(
    unitJob,
    /working-directory: packages\/desktop-web\/apps\/web\n        run: bunx vitest run/,
  );

  const browserConfig = readFileSync(
    new URL("packages/desktop-web/apps/web/vitest.browser.ci.config.ts", repoRoot),
    "utf8",
  );
  const projects = [...browserConfig.matchAll(/^          name: "([^"]+)",$/gm)].map(
    (match) => match[1],
  );
  assert.ok(projects.length > 1, "the browser CI config declares shard projects");
  const shardProjects = [];
  for (let shard = 1; shard <= projects.length; shard += 1) {
    const job = jobs.get(`desktop-web-browser-${shard}`)?.join("\n");
    assert.ok(job, `missing browser shard ${shard}`);
    if (shard === 1) {
      assert.match(
        job,
        /working-directory: packages\/desktop-web\/apps\/web\n        run: bun run test:browser:install/,
      );
      assert.match(
        job,
        /run: bunx vitest run --config vitest\.browser\.ci\.config\.ts --project="\$DESKTOP_WEB_BROWSER_PROJECT"/,
      );
    } else {
      // Later shards reuse the first shard's steps instead of copying them.
      assert.match(job, /^    steps: \*desktop_web_browser_steps$/m, `browser shard ${shard}`);
    }
    const project = /^      DESKTOP_WEB_BROWSER_PROJECT: (\S+)$/m.exec(job)?.[1];
    assert.ok(project, `browser shard ${shard} selects a project`);
    shardProjects.push(project);
  }
  assert.deepEqual(shardProjects.sort(), projects.sort());
  assert.ok(!jobs.has(`desktop-web-browser-${projects.length + 1}`));
});

test("desktop-web e2e builds the daemon page and runs the real-daemon suite", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const job = jobs.get("desktop-web-e2e")?.join("\n");
  assert.ok(job, "missing desktop-web-e2e job");
  assert.match(job, /run: node scripts\/npm-retry\.mjs ci/);
  assert.match(job, /run: npm run build:server/);
  assert.match(
    job,
    /working-directory: packages\/desktop-web\n        run: bun install --frozen-lockfile/,
  );
  assert.match(job, /run: npm run build:daemon-web-app/);
  assert.match(job, /run: npx playwright install --with-deps chromium/);
  assert.match(job, /run: npm run test:e2e:desktop-web --workspace=@neolix\/server/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**"],
    desktop: ["packages/desktop/**", "packages/server/src/server/browser-tools/**"],
    desktop_web: [
      "packages/desktop-web/**",
      "packages/client/**",
      "packages/protocol/**",
      "packages/relay/**",
      "packages/server/src/server/local-credential.ts",
      "CHANGELOG*.md",
    ],
    desktop_web_real_daemon: [
      "packages/desktop-web/**",
      "packages/server/**",
      "packages/client/**",
      "packages/protocol/**",
      "packages/relay/**",
      "scripts/build-daemon-web-app.mjs",
      "CHANGELOG*.md",
    ],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("desktop tests keep their directory-owned suite", () => {
  const filters = loadFilters(filtersPath);
  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/server/src/server/browser-tools/**",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/neolix-plugin.test.mjs",
      "node --test scripts/generate-install-sh.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@neolix/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@neolix/plugin",
      "npm run test --workspace=@neolix/protocol",
      "npm run test --workspace=@neolix/client",
      "npm run test --workspace=@neolix/highlight",
      "npm run typecheck:examples --workspace=@neolix/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@neolix\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@neolix\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@neolix\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@neolix\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@neolix\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  // CI must keep Vitest's own worker count; the cap applies to local runs only.
  assert.match(serverConfig, /maxWorkers: vitestMaxWorkers\(\)/);
  assert.doesNotMatch(serverConfig, /maxWorkers:\s*\d/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, outputs), units);
    assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("local Vitest runs cap workers while CI keeps Vitest's default", () => {
  assert.equal(
    vitestMaxWorkers({ CI: "true" }, () => 18),
    undefined,
  );
  assert.equal(
    vitestMaxWorkers({}, () => 18),
    4,
  );
  assert.equal(
    vitestMaxWorkers({}, () => 4),
    2,
  );
  assert.equal(
    vitestMaxWorkers({}, () => 1),
    1,
  );
  assert.equal(
    vitestMaxWorkers({ NEOX_TEST_MAX_WORKERS: "3" }, () => 18),
    3,
  );
  assert.equal(
    vitestMaxWorkers({ NEOX_TEST_MAX_WORKERS: "0" }, () => 18),
    4,
  );
  assert.equal(
    vitestMaxWorkers({ CI: "true", NEOX_TEST_MAX_WORKERS: "3" }, () => 18),
    3,
  );
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Neolix signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEOLIX_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// GitHub retires macOS 14 on 2026-11-02; brownouts already reject these jobs.
test("workflows avoid retired macOS 14 runners", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => /\.ya?ml$/.test(candidate))) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /macos-14(?:-large|-xlarge)?\b/,
      path,
    );
  }
});

test("macOS jobs use latest runners while preserving release architectures", () => {
  for (const [workflow, jobId] of [
    [ciWorkflowPath, "server-tests-macos"],
    [nixWorkflowPath, "build-desktop-darwin"],
  ]) {
    assert.match(
      jobBlocks(readFileSync(workflow, "utf8")).get(jobId).join("\n"),
      /^    runs-on: macos-latest$/m,
    );
  }
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  assert.match(release, /runner: macos-latest\n\s+electron_arch: arm64/);
  // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
  assert.match(release, /runner: macos-26-intel\n\s+electron_arch: x64/);
});

test("Nix desktop packaging resolves the workspace-local builder", () => {
  const source = readFileSync(new URL("nix/desktop-package.nix", repoRoot), "utf8");
  const invocation = source.match(/^\s+([^\n]*electron-builder) \\\n/m)?.[1];
  assert.ok(invocation, "Nix invokes the desktop packaging tool");
  const directory = mkdtempSync(join(tmpdir(), "nix-builder-resolution-"));
  try {
    const desktop = join(directory, "packages/desktop");
    mkdirSync(join(desktop, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(desktop, "node_modules/electron-builder"));
    writeFileSync(
      join(desktop, "node_modules/electron-builder/package.json"),
      JSON.stringify({
        name: "electron-builder",
        version: "1.0.0",
        bin: { "electron-builder": "../.bin/electron-builder" },
      }),
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/desktop"] }),
    );
    writeFileSync(
      join(desktop, "package.json"),
      JSON.stringify({
        name: "desktop-fixture",
        private: true,
        devDependencies: { "electron-builder": "1.0.0" },
      }),
    );
    writeFileSync(
      join(desktop, "node_modules/.bin/electron-builder"),
      '#!/bin/sh\nprintf "workspace-builder\\n"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-c", `${invocation} --version`], {
      cwd: desktop,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "workspace-builder");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
