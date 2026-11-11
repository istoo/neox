// FILE: ConnectionsSettingsPanel.tsx
// Purpose: The Connections pane — three tabs: devices that control this computer,
//          computers this one controls, and SSH.
// Layer: Settings UI components
// Exports: ConnectionsSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useAccount } from "~/hooks/useAccount";
import { useTranslation } from "~/i18n";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { useAccountDialogStore } from "../account/accountDialogStore";
import { NEOLIX_ACCOUNT_UI_ENABLED, NEOLIX_SYNC_KEY_UI_ENABLED } from "~/neolixFeatures";
import { SegmentedPicker } from "../SegmentedPicker";
import { Button } from "../ui/button";
import { ConnectionsOtherComputers } from "./ConnectionsOtherComputers";
import { ConnectionsThisComputer } from "./ConnectionsThisComputer";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

type ConnectionsTab = "this" | "others" | "ssh";

export function ConnectionsSettingsPanel({
  active,
  billingEnabled,
}: {
  active: boolean;
  billingEnabled: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ConnectionsTab>("this");
  const navigate = useNavigate();
  const account = useAccount();
  const openSignIn = useAccountDialogStore((store) => store.openSignIn);
  const capability = readExecutionContext()?.controller.capabilities;
  const billingOptions = accountBillingQueryOptions(account.status);
  const billing = useQuery({
    ...billingOptions,
    enabled:
      billingOptions.enabled === true &&
      active &&
      billingEnabled &&
      tab === "this" &&
      capability?.remoteConnections === true,
  });
  if (!active) return null;

  if (capability?.remoteConnections !== true)
    return (
      <SettingsSection title={t("settings:connections_title")}>
        <SettingsListRow
          title={t("settings:connections_unavailableInBuild")}
          description={
            capability?.remoteUnavailableReason ?? t("settings:connections_updateController")
          }
        />
      </SettingsSection>
    );

  // Neox has no account backend: hosts are registered against the daemon, so the
  // Connections pane must not demand a sign-in that can never happen.
  const signedIn = !NEOLIX_ACCOUNT_UI_ENABLED || account.me !== null;
  if (!signedIn)
    return (
      <SettingsSection title={t("settings:connections_title")}>
        <SettingsListRow
          title={t("settings:connections_signInToConnect")}
          description={t("settings:connections_useSameAccount")}
          actions={
            <Button size="xs" shape="capsule" onClick={openSignIn}>
              {t("settings:connections_signIn")}
            </Button>
          }
        />
      </SettingsSection>
    );

  const computerNoun = isMacNavigatorPlatform() ? "Mac" : t("settings:connections_computerNoun");
  const canViewProPlans =
    billingEnabled &&
    !billing.isError &&
    billing.data?.available &&
    billing.data.access === "none" &&
    billing.data.canCheckout;
  return (
    <div className="space-y-6">
      <SegmentedPicker<ConnectionsTab>
        ariaLabel={t("settings:connections_title")}
        variant="buttons"
        value={tab}
        onValueChange={setTab}
        options={[
          {
            value: "this",
            label: t("settings:connections_controlThis", { value0: computerNoun }),
          },
          { value: "others", label: t("settings:connections_controlOtherDevices") },
          { value: "ssh", label: "SSH" },
        ]}
      />
      <div>
        {tab === "this" ? (
          <ConnectionsThisComputer
            computerNoun={computerNoun}
            onRefreshBilling={billingEnabled ? () => void billing.refetch() : undefined}
            onViewProPlans={
              canViewProPlans
                ? () => void navigate({ to: "/settings", search: { section: "profile" } })
                : undefined
            }
          />
        ) : tab === "others" ? (
          <ConnectionsOtherComputers />
        ) : (
          <ConnectionsSsh />
        )}
      </div>
    </div>
  );
}

/** Only what exists today: device-code linking and a manual SSH forwarding port. */
function ConnectionsSsh() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <SettingsSection title="SSH">
      {/* Neox 无 device-code link 后端：不提供 Enter a code 入口。 */}
      {NEOLIX_SYNC_KEY_UI_ENABLED ? (
        <SettingsListRow
          title={t("settings:connections_linkHeadless")}
          description={t("settings:connections_linkHeadlessDescription")}
          actions={
            <Button
              size="xs"
              shape="capsule"
              variant="subtle"
              onClick={() => void navigate({ to: "/link" })}
            >
              {t("settings:connections_enterCode")}
            </Button>
          }
        />
      ) : null}
      <SettingsListRow
        title={t("settings:connections_portForwarding")}
        description={
          <>
            {t("settings:connections_portForwardingBefore")}{" "}
            <code className="font-mono text-ui-sm text-foreground">--ssh-forward-port</code>
            {t("settings:connections_portForwardingAfter")}
          </>
        }
      />
    </SettingsSection>
  );
}
