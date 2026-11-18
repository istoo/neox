// The MCP market's rows: a registry icon in the light theme, its `iconDark`
// variant in a dark one, and the muted placeholder when it cannot load.

import "../../index.css";

import type { LibrarySnapshot } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  searchMarket: vi.fn(),
  installMarketServer: vi.fn(),
}));

vi.mock("~/lib/neolixLibraryClient", () => ({ neolixLibraryApi: api }));

import { LibraryMcpMarketDialog } from "./LibraryMcpMarketDialog";

const library: LibrarySnapshot = {
  dir: "/home/qa/.neox/library",
  backupsDir: "/home/qa/.neox/library-backups",
  homeDir: "/home/qa",
  agents: [],
  instructions: { shared: "", sets: [], agents: [] },
  mcp: [],
  skills: [],
  hooks: [],
  subagents: [],
  counts: { mcp: 0, skills: 0, hooks: 0, subagents: 0, rtk: 0 },
};

function icon(color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`,
  )}`;
}

function marketServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "io.github.acme/paper",
    name: "paper",
    title: "Paper",
    description: "Notes",
    transport: "http" as const,
    inputs: [],
    ...overrides,
  };
}

async function renderDialog() {
  return render(
    <LibraryMcpMarketDialog open onOpenChange={() => {}} library={library} onChanged={() => {}} />,
  );
}

it("shows the icon, and its dark variant in a dark theme", async () => {
  const light = icon("red");
  const dark = icon("blue");
  api.searchMarket.mockResolvedValue({ servers: [marketServer({ icon: light, iconDark: dark })] });
  const screen = await renderDialog();
  try {
    await expect.element(page.getByText("Paper", { exact: true })).toBeVisible();
    const images = [...document.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual([light, dark]);
    // The title is beside it, so the image is decorative but still has alt.
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["", ""]);

    expect(getComputedStyle(images[0]!).display).not.toBe("none");
    expect(getComputedStyle(images[1]!).display).toBe("none");

    document.documentElement.classList.add("dark");
    expect(getComputedStyle(images[0]!).display).toBe("none");
    expect(getComputedStyle(images[1]!).display).not.toBe("none");
  } finally {
    document.documentElement.classList.remove("dark");
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("leaves the muted placeholder when the icon cannot load", async () => {
  api.searchMarket.mockResolvedValue({
    servers: [
      marketServer({
        id: "io.github.acme/broken",
        name: "broken",
        title: "Broken",
        icon: "https://127.0.0.1:1/missing.png",
      }),
      marketServer({ id: "io.github.acme/plain", name: "plain", title: "Plain" }),
    ],
  });
  const screen = await renderDialog();
  try {
    await expect.element(page.getByText("Broken", { exact: true })).toBeVisible();
    const image = document.querySelector("img");
    expect(image).not.toBeNull();
    image!.dispatchEvent(new Event("error"));
    await expect.poll(() => document.querySelectorAll("img").length).toBe(0);
    // Both the failed icon and the server without one get the same placeholder.
    await expect.poll(() => document.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});
