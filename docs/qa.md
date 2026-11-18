# QA

QA is the main bottleneck of Neox's product development.

The bar is four questions:

1. Does it work well?
2. Does it regress anything else?
3. Was it tested on every platform it affects?
4. Is there automated coverage, and is that coverage real?

Every pull request needs evidence for the questions its change touches. Pull requests without evidence get closed.

For plugin changes, verify the [SDK import boundaries](plugins.md#sdk-import-boundaries) before
exercising contributions. Include the boundary tests and both runtime loaders in the evidence.

## Evidence

Evidence is something someone else can look at:

- The commands you ran, pasted with their output
- The tests you added and their results
- Before and after screenshots
- A video of the interaction
- Logs, requests, responses

Redact what you need to, keep the technical details. If an agent did the work, submit its raw output. A summary drops the details someone else needs to check it.

## Does it work well

A feature that works but stutters, shifts the layout, or misaligns by two pixels is not done.

For UI, that means matching the web client's design system in visuals, in interaction, and in performance.

The two things that go wrong most often:

- **Layout shift.** Content that jumps as data arrives, a row that resizes when a badge appears, a panel that reflows on first render. Watch the change on a slow connection and on first load, not just after everything is warm.
- **Alignment.** Things align to their glyphs, not to their touch targets.

## Does it regress anything else

Neox is composable by design, which means your change sits next to features you didn't touch. Open the surfaces around it. A change to the agent list affects archive, subagents, and tabs; a change to git actions affects worktrees and the checkout flow.

Performance is part of this. The web client runs in Chromium inside the desktop shell and in an ordinary browser. What feels instant on a fast local build can be visibly slow with a loaded daemon, a large transcript, or a slower machine.

If your change touches a hot path such as the terminal, the message list, or git polling, submit before and after numbers. [terminal-performance.md](terminal-performance.md) has the terminal pipeline and its benchmarks, and [development.md](development.md) covers desktop renderer profiling.

## Every platform it affects

Your code does not only run on the platform you tested it on. The web client ships in Electron on
macOS, Windows, and Linux and can also be opened in a browser; the daemon runs on all three desktop
operating systems plus Docker.

You aren't expected to own every machine. You are expected to say what you covered:

| Platform        | Tested | Notes |
| --------------- | ------ | ----- |
| Browser         |        |       |
| Desktop macOS   |        |       |
| Desktop Windows |        |       |
| Desktop Linux   |        |       |

See [development.md](development.md) for running the daemon and desktop shell locally.

App and daemon versions also drift, in both directions. That has its own contract: [protocol-compatibility.md](protocol-compatibility.md).

## Automated coverage that means something

Tests are evidence only when they exercise the real thing.

- A bug fix needs a regression test that fails on the old code for the reported reason.
- A feature needs tests that go through the same interface a user or a caller uses.
- Web flows need an actual Playwright run, not a mocked-out approximation of one.
- Agent provider work needs manual verification against the real provider by someone who can tell that it worked. A fixture and a mock prove the fixture parses, nothing more.

Tests that mock away the behavior, assert on internals, or pass against the broken code claim coverage that isn't there.

[testing.md](testing.md) is the standard, including how to run suites without freezing your machine. For driving a real daemon in a test, see [ad-hoc-daemon-testing.md](ad-hoc-daemon-testing.md). For Electron screenshots, [browser-capture-harness.md](browser-capture-harness.md).
