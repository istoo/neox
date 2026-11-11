import { PluginTranslationRuntime } from "@neolix/plugin/client/host";
import { useNeolix, useRpc } from "@neolix/plugin/client";
import { defineRpc } from "@neolix/plugin";
import type { NeolixApi } from "@neolix/client";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { z } from "zod";
import { PluginInstallationProvider } from "./installation-provider";
import type { InstalledPlugin } from "./types";

const status = defineRpc({
  name: "deploys.status",
  input: z.object({}),
  output: z.object({ state: z.string() }),
});

function installation(invoked: string[]): InstalledPlugin {
  return {
    id: "deploys",
    serverId: "host",
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    neolix: { dispose: async () => undefined } as NeolixApi,
    invoke: async (method) => {
      invoked.push(method);
      return { state: "green" };
    },
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    providerActions: [],
    providerPanels: [],
    agentActions: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

it("gives every surface the installation's client and RPCs on its first frame", async () => {
  const invoked: string[] = [];
  const plugin = installation(invoked);
  const received: NeolixApi[] = [];
  let rpc: ((input: Record<string, never>) => Promise<unknown>) | null = null;
  function Surface({ name }: { name: string }) {
    received.push(useNeolix());
    rpc = useRpc(status);
    return <span>{name}</span>;
  }

  const markup = ["Screen", "Sidebar item", "Popover"]
    .map((name) =>
      renderToStaticMarkup(
        <PluginInstallationProvider plugin={plugin}>
          <Surface name={name} />
        </PluginInstallationProvider>,
      ),
    )
    .join("");

  expect(markup).toBe("<span>Screen</span><span>Sidebar item</span><span>Popover</span>");
  expect(received).toEqual([plugin.neolix, plugin.neolix, plugin.neolix]);
  expect(received.every((neolix) => neolix === plugin.neolix)).toBe(true);
  await expect(rpc!({})).resolves.toEqual({ state: "green" });
  expect(invoked).toEqual(["deploys.status"]);
});
