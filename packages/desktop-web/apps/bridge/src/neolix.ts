// The bridge is a plain Neox client. It imports the workspace builds of @neolix/client and the
// server's credential reader by path, so Node resolves their own imports (@neolix/protocol, …)
// from this checkout instead of a registry copy that would miss local protocol changes.
import { createHostClient } from "../../../../client/dist/node/index.js";
import type { DaemonClient } from "../../../../client/dist/daemon-client.js";
import { readLocalCredentialForTarget } from "../../../../server/dist/server/server/local-credential.js";

export type { DaemonClient };

export interface ConnectNeolixOptions {
  readonly host: string;
  readonly home: string;
  readonly log: (line: string) => void;
}

export async function connectNeolix(options: ConnectNeolixOptions): Promise<DaemonClient> {
  const client = createHostClient(options.host, {
    clientId: "neolix-desktop-web-bridge",
    clientType: "cli",
    appVersion: "0.15.0",
    localCredential: () => readLocalCredentialForTarget(options.home, options.host) ?? undefined,
    connectTimeoutMs: 15_000,
    reconnect: { enabled: true },
  }) as DaemonClient;
  client.subscribeConnectionStatus((status) => options.log(`daemon connection: ${status.status}`));
  await client.connect();
  return client;
}
