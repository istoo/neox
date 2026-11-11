import { createFileRoute, redirect } from "@tanstack/react-router";

// Automations now live inside Settings › Scheduled tasks.
export const Route = createFileRoute("/_chat/automations/")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings",
      search: { section: "scheduled-tasks" },
      replace: true,
    });
  },
});
