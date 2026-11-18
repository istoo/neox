import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@neolix/plugin/server/provider";

const provider: ProviderRegistration = {
  id: "plugin-base",
  label: "Plugin base",
  supportsAccountDerivation: true,
  async status() {
    return { available: true };
  },
  async connect() {
    let listener: ((event: ProviderEvent) => void) | undefined;
    return {
      version: 1,
      capabilities: ["session.persistence", "prompt.message"],
      async send(input: ProviderInput) {
        if (input.type === "catalog") {
          listener?.({
            type: "catalog",
            requestId: input.requestId,
            catalog: { models: [{ id: "plugin-model", label: "Plugin model" }], modes: [] },
          });
        }
      },
      onEvent(next) {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
      async close() {},
    };
  },
};

export default function contribute(server: { registerProvider(p: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}
