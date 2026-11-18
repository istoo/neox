// Installs the standalone bundle's own copy of the Neox client. `main.ts` imports this
// for side effects; `embed.ts` never does, so the daemon-hosted bundle stays without it.
import * as daemonClient from "../../../../client/dist/daemon-client.js";
import * as hosts from "../../../../client/dist/hosts/index.js";
import * as node from "../../../../client/dist/node/index.js";
import { CLIENT_CAPS } from "../../../../protocol/dist/client-capabilities.js";
import { readLocalCredentialForTarget } from "../../../../server/dist/server/server/local-credential.js";

import { installBridgeClientRuntime } from "./clientRuntime.ts";

installBridgeClientRuntime({
  node,
  daemonClient,
  hosts,
  clientCaps: CLIENT_CAPS,
  readLocalCredentialForTarget,
});
