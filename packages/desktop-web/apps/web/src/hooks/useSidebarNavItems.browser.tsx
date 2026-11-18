import "../index.css";

import type { NeolixPlugin } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useSidebarNavItems } from "./useSidebarNavItems";
import type { SidebarNavSection } from "~/lib/sidebarNav.model";

const fixture = vi.hoisted(() => ({
  plugins: [] as NeolixPlugin[],
  updateSettings: (() => undefined) as (patch: unknown) => void,
}));

vi.mock("~/plugins/catalog", () => ({
  useRunningPlugins: () => fixture.plugins,
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: { sidebarNavItems: [], sidebarFooterItems: [], showRailUsage: true },
    updateSettings: fixture.updateSettings,
  }),
}));

vi.mock("~/hooks/useBuiltinFeatures", () => ({
  useBuiltinFeatures: () => ({ isEnabled: () => true }),
}));

const notes = (replaces: "sessions" | "usage", section: "header" | "footer"): NeolixPlugin => ({
  id: "notes",
  name: "Notes",
  path: "/plugins/notes",
  enabled: true,
  status: "running",
  contributions: {
    sidebarItems: [{ id: "main", title: "Notes", view: "main", section, replaces }],
  },
});

function SidebarRows({ section }: { section: SidebarNavSection }) {
  const { items } = useSidebarNavItems(section);
  return (
    <ul>
      {items
        .filter((item) => item.visible)
        .map((item) => (
          <li key={item.key}>
            {item.kind === "builtin" ? item.id : item.entry.contribution.title}
          </li>
        ))}
    </ul>
  );
}

let screen: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  fixture.plugins = [];
});

afterEach(async () => {
  await screen?.unmount();
  screen = null;
});

it("shows a plugin row in History's slot instead of the built-in row", async () => {
  fixture.plugins = [notes("sessions", "header")];
  screen = await render(<SidebarRows section="header" />);

  await expect.element(page.getByText("Notes")).toBeVisible();
  await expect.element(page.getByText("new-thread")).toBeVisible();
  await expect.element(page.getByText("history")).not.toBeInTheDocument();
});

it("moves a footer plugin row into Usage's slot", async () => {
  fixture.plugins = [notes("usage", "footer")];
  screen = await render(<SidebarRows section="footer" />);

  await expect.element(page.getByText("Notes")).toBeVisible();
  await expect.element(page.getByText("usage")).not.toBeInTheDocument();
});

it("brings the built-in row back once the plugin is gone", async () => {
  fixture.plugins = [notes("sessions", "header")];
  screen = await render(<SidebarRows section="header" />);
  await expect.element(page.getByText("Notes")).toBeVisible();

  fixture.plugins = [];
  await screen.rerender(<SidebarRows section="header" />);

  await expect.element(page.getByText("history")).toBeVisible();
  await expect.element(page.getByText("Notes")).not.toBeInTheDocument();
});
