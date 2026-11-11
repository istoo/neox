import { render, Box, Text, useInput } from "ink";
import React, { createElement } from "react";
import { TuiApp } from "./app.js";
import { connectTui, describeTarget, errorText, type TuiOptions } from "./data.js";

/**
 * `neolix tui`'s lifecycle: one daemon connection, the alternate screen while
 * it is interactive, and a retry screen when the daemon can't be reached.
 */

function ConnectionError({
  target,
  error,
  onRetry,
  onQuit,
}: {
  target: string;
  error: string;
  onRetry: () => void;
  onQuit: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onQuit();
      return;
    }
    if (input === "q" || key.escape) {
      onQuit();
      return;
    }
    if (input === "r") {
      onRetry();
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold color="blue">
        ◉ Neox
      </Text>
      <Text> </Text>
      <Text color="red">{`  ✗ ${error}`}</Text>
      <Text> </Text>
      <Text color="gray">{`  target: ${target}`}</Text>
      <Text> </Text>
      <Text>
        <Text>r</Text>
        <Text color="gray"> retry</Text>
        <Text>{"   q"}</Text>
        <Text color="gray"> quit</Text>
      </Text>
    </Box>
  );
}

function showConnectionError(target: string, error: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (retry: boolean) => {
      if (done) return;
      done = true;
      resolve(retry);
      instance.unmount();
    };
    const instance = render(
      createElement(ConnectionError, {
        target,
        error,
        onRetry: () => finish(true),
        onQuit: () => finish(false),
      }),
      { alternateScreen: true, exitOnCtrlC: false, patchConsole: false },
    );
    void instance.waitUntilExit();
  });
}

export async function runTui(options: TuiOptions): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const noColor = options.color === false;
  for (;;) {
    let target = describeTarget(options);
    try {
      const connection = await connectTui(options);
      target = connection.target;
      const instance = render(
        createElement(TuiApp, {
          client: connection.client,
          target: connection.target,
          interactive,
          exitAfterLoad: !interactive,
          noColor,
        }),
        {
          alternateScreen: interactive,
          exitOnCtrlC: false,
          patchConsole: false,
          interactive,
        },
      );
      await instance.waitUntilExit();
      await connection.close();
      return 0;
    } catch (error) {
      const text = errorText(error);
      if (!interactive) {
        process.stderr.write(`${text}\n`);
        return 1;
      }
      const retry = await showConnectionError(target, text);
      if (!retry) return 1;
    }
  }
}
