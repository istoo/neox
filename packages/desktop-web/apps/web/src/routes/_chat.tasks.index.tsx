import { createFileRoute, redirect } from "@tanstack/react-router";

import TasksView from "~/components/tasks/TasksView";
import { isTasksSurfaceEnabled, NEOLIX_TASKS_ENABLED } from "~/tasksSurface";

export const Route = createFileRoute("/_chat/tasks/")({
  // Older servers without Tasks, or Neox without a todo backend, fall back to Kanban.
  beforeLoad: () => {
    if (!NEOLIX_TASKS_ENABLED || !isTasksSurfaceEnabled()) {
      throw redirect({ to: "/kanban", replace: true });
    }
  },
  component: TasksView,
});
