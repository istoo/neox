import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  setVisible: vi.fn(),
  move: vi.fn(),
}));

vi.mock("~/hooks/useSidebarNavItems", () => ({
  useSidebarNavItems: (section: "header" | "footer") => ({
    items:
      section === "header"
        ? [
            { kind: "builtin", key: "new-thread", id: "new-thread", visible: true },
            { kind: "builtin", key: "history", id: "history", visible: true },
            {
              kind: "plugin",
              key: "plugin:notes:main",
              visible: true,
              entry: {
                pluginId: "notes",
                pluginName: "Notes",
                contribution: { id: "main", title: "Notes", view: "main", section: "header" },
              },
            },
          ]
        : [{ kind: "builtin", key: "usage", id: "usage", visible: true }],
    setVisible: fixture.setVisible,
    move: fixture.move,
  }),
}));

const { SidebarNavSettingsSection } = await import("./SidebarNavSettingsSection");

it("lists the sidebar's built-in rows in their sections", async () => {
  const screen = await render(<SidebarNavSettingsSection />);
  await expect.element(screen.getByRole("switch", { name: "New thread" })).toBeInTheDocument();
  await expect.element(screen.getByRole("switch", { name: "History" })).toBeInTheDocument();
  await expect.element(screen.getByRole("switch", { name: "Usage" })).toBeInTheDocument();
});

it("writes visibility for the row that changed", async () => {
  fixture.setVisible.mockClear();
  const screen = await render(<SidebarNavSettingsSection />);
  await screen.getByRole("switch", { name: "History" }).click();
  expect(fixture.setVisible).toHaveBeenCalledWith("history", false);
});

it("moves a row with the arrow controls", async () => {
  fixture.move.mockClear();
  const screen = await render(<SidebarNavSettingsSection />);
  await screen.getByRole("button", { name: "Move Notes up" }).click();
  expect(fixture.move).toHaveBeenCalledWith("plugin:notes:main", "up");
});

it("disables a move whose only neighbour is a pinned row", async () => {
  fixture.move.mockClear();
  const screen = await render(<SidebarNavSettingsSection />);
  const moveHistoryUp = screen.getByRole("button", { name: "Move History up" });
  await expect.element(moveHistoryUp).toBeDisabled();
  await moveHistoryUp.click({ force: true });
  expect(fixture.move).not.toHaveBeenCalled();
});
