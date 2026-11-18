import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatShell } from "./ChatShell";
import type { SidebarContextProps } from "./ui/sidebar";

it("keeps the remote card on the same inset surface and follows the controller sidebar", async () => {
  await page.viewport(1100, 800);
  const controls: SidebarContextProps = {
    open: true,
    state: "expanded",
    isMobile: false,
    openMobile: false,
    setOpen: () => {},
    setOpenMobile: () => {},
    toggleSidebar: () => {},
  };
  const content = (
    <main data-testid="card" className="chat-content-card relative flex-1">
      Remote chat
    </main>
  );
  // ChatShell now hosts the app-settings sync hook, which reads react-query; the app
  // root always provides this client, so the standalone shell needs one too.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatShell open={false} controls={controls}>
        {content}
      </ChatShell>
    </QueryClientProvider>,
  );
  const card = page.getByTestId("card").element();
  await expect.poll(() => parseFloat(getComputedStyle(card).marginRight)).toBeGreaterThan(0);
  await expect.poll(() => parseFloat(getComputedStyle(card).marginBottom)).toBeGreaterThan(0);
  await expect.poll(() => parseFloat(getComputedStyle(card, "::after").top)).toBeGreaterThan(0);
  await expect
    .poll(() => parseFloat(getComputedStyle(card, "::after").borderTopLeftRadius))
    .toBe(0);
  await screen.rerender(
    <QueryClientProvider client={client}>
      <ChatShell open={false} controls={{ ...controls, open: false, state: "collapsed" }}>
        {content}
      </ChatShell>
    </QueryClientProvider>,
  );
  await expect
    .poll(() => parseFloat(getComputedStyle(card, "::after").borderTopLeftRadius))
    .toBeGreaterThan(0);
});
