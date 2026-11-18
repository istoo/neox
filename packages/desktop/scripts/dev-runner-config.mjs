export function createElectronSpawnOptions({ env, colorEnv }) {
  return {
    // Electron must stay in the runner's process group. Neolix workspace scripts
    // own the terminal process group, so detaching Electron lets it survive a
    // service stop with broken stdout/stderr pipes and block the next launch.
    detached: false,
    env: {
      ...env,
      ...colorEnv,
    },
  };
}

export function resolveChildKillTarget(pid, detached) {
  return detached ? -pid : pid;
}

export function registerDevRunnerShutdownSignals({ signalSource, stop }) {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    signalSource.on(signal, () => stop("SIGTERM"));
  }
}
