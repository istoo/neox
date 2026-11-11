import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { PluginLibrary } from "./PluginLibrary";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ neolix: undefined }),
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "",
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));

it("renders Neox plugin management tabs instead of provider plugin discovery", () => {
  const markup = renderToStaticMarkup(<PluginLibrary embedded />);
  expect(markup).toContain("Installed");
  expect(markup).toContain("Market");
  expect(markup).toContain("Built-in");
  expect(markup).not.toContain("Codex");
});

it("offers a host-wide install source field", () => {
  const markup = renderToStaticMarkup(<PluginLibrary embedded />);
  expect(markup).toContain("Install from:");
});
