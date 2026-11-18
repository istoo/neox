// FILE: DesktopSettingsPanel.tsx
// Purpose: Settings › Desktop. Groups every shell-owned preference that the
//          legacy renderer kept in General (login, Dock, sleep, tray, shortcuts,
//          updates). The whole panel is absent in a plain browser, where there
//          is no shell to configure.
// Layer: Settings UI components
// Exports: DesktopSettingsPanel

import { desktopShellAvailable } from "./desktopShellSettings";
import {
  DesktopCliSettingsSection,
  DesktopSystemSettingsSection,
  DesktopTraySettingsSection,
  DesktopUpdatePolicySettingsSection,
} from "./DesktopSystemSettingsSection";

export function DesktopSettingsPanel({ active }: { readonly active: boolean }) {
  const available = desktopShellAvailable();
  if (!active || !available) return null;
  return (
    <div className="space-y-6">
      <DesktopSystemSettingsSection active={active} />
      <DesktopUpdatePolicySettingsSection active={active} />
      <DesktopTraySettingsSection active={active} />
      <DesktopCliSettingsSection active={active} />
    </div>
  );
}
