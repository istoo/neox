// The attachment picker searches through the plugin's RPC: typing is debounced, and an
// older, slower response never replaces the results for what the user typed since.

import "../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("~/plugins/catalog", () => ({ useRunningPlugins: () => [] }));
vi.mock("~/plugins/contributions", () => ({
  buildPluginContributionIndex: () => ({
    attachmentSources: [
      {
        pluginId: "issues",
        contribution: { id: "issue", title: "Issues", search: { method: "search" } },
      },
    ],
  }),
  invokePluginRpc: rpc,
}));

const { PluginAttachmentSources } = await import("~/plugins/PluginAttachmentSources");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("debounces typing and ignores a stale response", async () => {
  const opening = deferred<unknown>();
  rpc.mockReset();
  rpc.mockImplementation((_plugin: string, _method: string, input: { query: string }) =>
    input.query === ""
      ? opening.promise
      : Promise.resolve({ items: [{ id: input.query, title: `Result ${input.query}` }] }),
  );

  const screen = await render(<PluginAttachmentSources onAttach={() => {}} />);
  await screen.getByRole("button", { name: "Issues" }).click();
  const field = screen.getByPlaceholder("Search…");
  await field.fill("a");
  await field.fill("ab");
  await expect.element(screen.getByText("Result ab")).toBeVisible();

  // The opening search answers last; it must not replace the newer results.
  opening.resolve({ items: [{ id: "all", title: "Everything" }] });
  await new Promise((done) => setTimeout(done, 50));
  await expect.element(screen.getByText("Result ab")).toBeVisible();
  expect(screen.getByText("Everything").elements()).toHaveLength(0);

  const queries = rpc.mock.calls.map((call) => (call[2] as { query: string }).query);
  expect(queries).toEqual(["", "ab"]);
});
