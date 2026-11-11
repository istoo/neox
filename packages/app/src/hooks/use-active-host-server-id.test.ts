// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  active: null as { serverId: string; workspaceId: string } | null,
  last: null as { serverId: string; workspaceId: string } | null,
  hosts: [{ serverId: "local" }, { serverId: "remote" }],
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useLocalDaemonServerId: () => "local" }));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => state.hosts }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => state.active,
  useLastWorkspaceSelection: () => state.last,
}));

import { useActiveHostServerId } from "./use-active-host-server-id";

afterEach(cleanup);
beforeEach(() => {
  state.active = null;
  state.last = null;
  state.hosts = [{ serverId: "local" }, { serverId: "remote" }];
});

describe("功能页主机归属", () => {
  it("从远程工作区打开全局功能页后仍使用该主机", () => {
    state.last = { serverId: "remote", workspaceId: "workspace-a" };
    const { result } = renderHook(useActiveHostServerId);
    expect(result.current).toBe("remote");
  });
  it("当前工作区优先于历史工作区", () => {
    state.active = { serverId: "local", workspaceId: "workspace-b" };
    state.last = { serverId: "remote", workspaceId: "workspace-a" };
    const { result } = renderHook(useActiveHostServerId);
    expect(result.current).toBe("local");
  });
  it("历史主机已移除时沿用已有本地主机回退", () => {
    state.last = { serverId: "removed", workspaceId: "workspace-a" };
    const { result } = renderHook(useActiveHostServerId);
    expect(result.current).toBe("local");
  });
  it("未注册任何主机时不伪造目标", () => {
    state.hosts = [];
    const { result } = renderHook(useActiveHostServerId);
    expect(result.current).toBeNull();
  });
});
