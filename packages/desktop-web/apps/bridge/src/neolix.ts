// The bridge is a plain Neox client. The client, its protocol constants and the server's
// credential reader come from `clientRuntime`: the standalone bundle installs its own
// copies, the daemon injects the ones it already loaded (see `embed.ts`).
import type { DaemonClient } from "../../../../client/dist/daemon-client.js";
import type { DaemonTransportFactory } from "../../../../client/dist/daemon-client-transport-types.js";

import { bridgeClientRuntime } from "./clientRuntime.ts";

export type { DaemonClient };

export interface ConnectNeolixOptions {
  readonly host: string;
  readonly home: string;
  readonly log: (line: string) => void;
  /**
   * The daemon's in-process transport (see `embed.ts`). When present the bridge skips the
   * loopback socket, the WS handshake and the credential file.
   */
  readonly daemonTransport?: DaemonTransportFactory;
}

export async function connectNeolix(options: ConnectNeolixOptions): Promise<DaemonClient> {
  const daemonTransport = options.daemonTransport;
  const runtime = bridgeClientRuntime();
  const client = runtime.node.createHostClient(options.host, {
    clientId: "neolix-desktop-web-bridge",
    clientType: "cli",
    appVersion: "0.15.0",
    ...(daemonTransport
      ? {
          transportFactory: daemonTransport,
          // The in-process socket carries whole frames; there is nothing to chunk.
          capabilities: { [runtime.clientCaps.binaryChunkingV1]: false },
        }
      : {
          // COMPAT(webAppInProcess): added in v0.16.5, remove after 2027-05-14 once every
          // hosted app is in-process; the standalone dev bridge still dials loopback TCP.
          localCredential: () =>
            runtime.readLocalCredentialForTarget(options.home, options.host) ?? undefined,
        }),
    connectTimeoutMs: 15_000,
    reconnect: { enabled: true },
  }) as DaemonClient;
  client.subscribeConnectionStatus((status) => options.log(`daemon connection: ${status.status}`));
  await client.connect();
  return client;
}
