// Project icons → Synara RPCs (`neolix.projectIcons.*`).
//
// The daemon owns both surfaces: `project.icon.get` answers the effective icon
// for a registered project (custom upload or automatic discovery) and
// `project_icon_request` is the pre-custom-icon cwd lookup. The bridge only
// forwards, plus reports the host feature flag so the web can hide a write the
// host would reject.
import {
  NEOLIX_PROJECT_ICON_WS_METHODS,
  type ProjectIconGetInput,
  type ProjectIconRequestInput,
  type ProjectIconSetInput,
} from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { bridgeError, fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

export function makeProjectIconHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  const supportsCustomIcons = () =>
    client.getLastServerInfoMessage()?.features?.projectCustomIcon === true;

  return {
    [NEOLIX_PROJECT_ICON_WS_METHODS.get]: (payload) =>
      fromPromise("neolix.projectIcons.get", async () => {
        if (!supportsCustomIcons()) return { icon: null, supportsCustomIcons: false };
        const input = payload as ProjectIconGetInput;
        const result = await client.getProjectIcon(input.projectId);
        if (result.error) throw new Error(result.error);
        return { icon: result.icon, supportsCustomIcons: true };
      }),

    [NEOLIX_PROJECT_ICON_WS_METHODS.request]: (payload) =>
      fromPromise("neolix.projectIcons.request", async () => {
        const input = payload as ProjectIconRequestInput;
        const result = await client.requestProjectIcon(input.cwd);
        if (result.error) throw new Error(result.error);
        return { icon: result.icon };
      }),

    [NEOLIX_PROJECT_ICON_WS_METHODS.set]: (payload) =>
      fromPromise("neolix.projectIcons.set", async () => {
        if (!supportsCustomIcons()) {
          throw bridgeError(
            "project.icon-unsupported",
            "This host's daemon does not support custom project icons. Update the host.",
          );
        }
        const input = payload as ProjectIconSetInput;
        await client.setProjectIcon(input.projectId, input.source);
        return {};
      }),
  };
}
