// The bridge runs in two places. Standalone (`bun src/main.ts`) it bundles its own copy
// of @neolix/client. Embedded (`embed.js`), the daemon already has that client loaded, so
// it injects its modules here instead of the bundle shipping a second copy of the client
// and the protocol's generated validators (~15 MB).
//
// Type-only imports never reach the bundle: only the daemon (or `clientRuntime.node.ts`,
// used by the standalone entry) calls `installBridgeClientRuntime`.

export interface BridgeClientRuntime {
  readonly node: typeof import("../../../../client/dist/node/index.js");
  readonly daemonClient: typeof import("../../../../client/dist/daemon-client.js");
  readonly hosts: typeof import("../../../../client/dist/hosts/index.js");
  readonly clientCaps: typeof import("../../../../protocol/dist/client-capabilities.js").CLIENT_CAPS;
  readonly readLocalCredentialForTarget: typeof import("../../../../server/dist/server/server/local-credential.js").readLocalCredentialForTarget;
}

let runtime: BridgeClientRuntime | null = null;

export function installBridgeClientRuntime(next: BridgeClientRuntime): void {
  runtime = next;
}

export function bridgeClientRuntime(): BridgeClientRuntime {
  if (runtime === null) {
    throw new Error(
      "The bridge client runtime was not installed. Start the app through the daemon, or import clientRuntime.node.ts in a standalone entry.",
    );
  }
  return runtime;
}
