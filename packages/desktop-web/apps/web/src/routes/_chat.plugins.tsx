import { createFileRoute, redirect } from "@tanstack/react-router";

// The plugin browser now lives inside Settings › Plugins.
export const Route = createFileRoute("/_chat/plugins")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings",
      search: { section: "plugins" },
      replace: true,
    });
  },
});
