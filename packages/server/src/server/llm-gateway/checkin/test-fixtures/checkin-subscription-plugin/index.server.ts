import type { SubscriptionProviderRegistration } from "@neolix/plugin/server";

const provider: SubscriptionProviderRegistration = {
  id: "demo-checkin",
  label: "Demo check-in",
  protocol: "openai",
  methods: [{ type: "api", label: "API key" }],
  async loader() {
    return { baseUrl: "https://demo.invalid/v1", headers: {} };
  },
  async models() {
    return [{ id: "demo-model", name: "Demo model" }];
  },
  async checkin({ accountId }) {
    return { outcome: "claimed", credit: 42, message: `checked in ${accountId}` };
  },
};

export default function contribute(server: {
  registerSubscriptionProvider(p: SubscriptionProviderRegistration): void;
}) {
  server.registerSubscriptionProvider(provider);
  return () => undefined;
}
