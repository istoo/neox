import { describe, expect, it } from "vitest";
import {
  installPlan,
  launchAgentFile,
  systemdUnit,
  systemdUnitFile,
  uninstallPlan,
  unitQuote,
  unsupportedService,
  type ServiceSpec,
} from "./service.js";

function spec(overrides: Partial<ServiceSpec>): ServiceSpec {
  return {
    platform: "darwin",
    home: "/Users/me",
    exe: "/usr/local/bin/node",
    args: ["/opt/neolix/cli.js", "daemon", "run"],
    env: ["PATH=/usr/bin:/bin", "NEOLIX_HOME=/Users/me/.neox"],
    ...overrides,
  };
}

describe("neox daemon install", () => {
  it("writes myna's launch agent on macOS", () => {
    const plan = installPlan(spec({ platform: "darwin" }));
    expect(plan.file).toBe(launchAgentFile("/Users/me"));
    expect(plan.file).toMatch(/Library\/LaunchAgents\/com\.neolix\.serve\.plist$/);
    expect(plan.contents).toContain("<key>Label</key><string>com.neolix.serve</string>");
    expect(plan.contents).toContain(
      "<string>/usr/local/bin/node</string><string>/opt/neolix/cli.js</string><string>daemon</string><string>run</string>",
    );
    expect(plan.contents).toContain("<key>RunAtLoad</key><true/>");
    expect(plan.contents).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
    expect(plan.contents).toContain("<key>NEOLIX_HOME</key><string>/Users/me/.neox</string>");
    expect(plan.commands[0]).toEqual(["launchctl", "bootout", "gui/501/com.neolix.serve"]);
    expect(plan.commands[1]?.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    expect(plan.logs).toContain("tail -f");
  });

  it("writes myna's systemd user unit on Linux", () => {
    const plan = installPlan(
      spec({ platform: "linux", home: "/home/me", xdgConfigHome: "/home/me/.config" }),
    );
    expect(plan.file).toBe(
      systemdUnitFile({ home: "/home/me", xdgConfigHome: "/home/me/.config" }),
    );
    expect(plan.file).toMatch(/systemd\/user\/neolix\.service$/);
    expect(plan.contents).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/neolix/cli.js" "daemon" "run"',
    );
    expect(plan.contents).toContain("Restart=on-failure");
    expect(plan.contents).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(plan.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "neolix.service"],
      ["systemctl", "--user", "restart", "neolix.service"],
    ]);
    expect(plan.logs).toBe("journalctl --user -u neolix -f");
  });

  it("escapes a unit's words as systemd reads them", () => {
    expect(unitQuote('a b%"c\\d')).toBe('"a b%%\\"c\\\\d"');
    const unit = systemdUnit(spec({ platform: "linux", env: ["TOKEN=a%b"] }));
    expect(unit).toContain('Environment="TOKEN=a%%b"');
  });

  it("removes the service the same way myna does", () => {
    expect(uninstallPlan(spec({ platform: "darwin" })).commands).toEqual([
      ["launchctl", "bootout", "gui/501/com.neolix.serve"],
    ]);
    expect(uninstallPlan(spec({ platform: "linux" })).commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "neolix.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("has no service installer on Windows, as myna has none", () => {
    expect(() => installPlan(spec({ platform: "win32" }))).toThrow(
      /no service installer on Windows/,
    );
    expect(unsupportedService("win32").message).toContain("inside WSL");
  });
});
