// Subscription controls reuse profile Settings and the server-selected billing environment.
import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "~/hooks/useAccount";
import { t } from "~/i18n";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import {
  formatBillingPrice,
  isPolarBillingUrl,
  runAccountBillingOperation,
} from "~/lib/accountBilling";
import { accountStatusScope } from "~/lib/hosts/controlQueryScope";
import { ensureNativeApi } from "~/nativeApi";
import { useAccountDialogStore } from "../account/accountDialogStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

function rejectUnverifiedBillingLink(): never {
  throw new Error("The billing link could not be verified.");
}

export function BillingSettingsPanel() {
  const { status } = useAccount();
  const scope = accountStatusScope(status ?? { state: "signed-out" });
  return <BillingAccountPanel key={scope} status={status} scope={scope} />;
}

function BillingAccountPanel({ status, scope }: { status: AccountStatus | null; scope: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(accountBillingQueryOptions(status));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const signedIn = status?.state === "signed-in";
  const billing = query.data;
  const sandbox = billing?.environment === "sandbox";

  const openBilling = async (interval?: "month" | "year") => {
    if (pending || !signedIn || !billing?.available) return;
    setPending(true);
    setMessage(null);
    const openedMessage = sandbox
      ? t("settings:billingOpenedSandbox")
      : t("settings:billingOpened");
    const failedMessage = sandbox
      ? "Could not open test billing. Try again."
      : "Could not open billing. Try again.";
    try {
      const redirect = await runAccountBillingOperation(scope, (account) =>
        interval ? account.billingCheckout({ interval }) : account.billingPortal(),
      );
      if (!mounted.current) return;
      if (redirect.environment !== billing.environment) {
        rejectUnverifiedBillingLink();
      }
      if (!isPolarBillingUrl(redirect.url, billing.environment)) {
        rejectUnverifiedBillingLink();
      }
      await ensureNativeApi().shell.openExternal(redirect.url);
      if (mounted.current) {
        setMessage(openedMessage);
      }
    } catch {
      if (mounted.current) {
        setMessage(failedMessage);
      }
    }
    if (mounted.current) {
      setPending(false);
      void queryClient.invalidateQueries({
        queryKey: accountBillingQueryOptions(status).queryKey,
      });
    }
  };

  return (
    <SettingsSectionShell
      title={t("settings:subscription")}
      action={
        billing ? (
          <Badge variant="outline">
            {sandbox ? t("settings:sandbox") : t("settings:production")}
          </Badge>
        ) : undefined
      }
    >
      <SettingsCard>
        {!signedIn ? (
          <SettingsListRow
            title={t("settings:billingAlto")}
            description={t("settings:altoDescription")}
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={!status}
                onClick={() => useAccountDialogStore.getState().openSignIn()}
              >
                {t("common:signIn")}
              </Button>
            }
          />
        ) : query.isPending ? (
          <SettingsListRow
            title={t("settings:loadingSubscription")}
            description={t("settings:checkingSubscription")}
          />
        ) : query.isError ? (
          <SettingsListRow
            title={t("settings:subscriptionUnavailable")}
            description={t("settings:couldNotCheckBilling")}
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("common:tryAgain")}
              </Button>
            }
          />
        ) : !billing?.available ? (
          <SettingsListRow
            title={
              sandbox ? t("settings:testBillingNotConfigured") : t("settings:billingNotConfigured")
            }
            description={t("settings:billingUnchangedCompanions")}
          />
        ) : (
          <>
            <SettingsListRow
              title={sandbox ? t("settings:billingTestAlto") : t("settings:billingAlto")}
              description={subscriptionDescription(billing)}
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={query.isFetching || pending}
                  onClick={() => void query.refetch()}
                >
                  {t("settings:billingRefresh")}
                </Button>
              }
            />
            {billing.canCheckout
              ? billing.plans.map((plan) => (
                  <SettingsListRow
                    key={plan.interval}
                    title={
                      plan.interval === "month"
                        ? t("settings:billingMonthly")
                        : t("settings:billingAnnual")
                    }
                    description={
                      plan.interval === "month"
                        ? t("settings:billingPerMonth", { price: formatBillingPrice(plan) })
                        : t("settings:billingPerYear", { price: formatBillingPrice(plan) })
                    }
                    actions={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void openBilling(plan.interval)}
                      >
                        {sandbox
                          ? t("settings:billingTestCheckout")
                          : t("settings:billingCheckout")}
                      </Button>
                    }
                  />
                ))
              : null}
            {billing.canManage ? (
              <SettingsListRow
                title={
                  sandbox
                    ? t("settings:billingManageTestSubscription")
                    : t("settings:billingManageSubscription")
                }
                description={
                  sandbox
                    ? t("settings:billingManageSandboxDescription")
                    : t("settings:billingManageDescription")
                }
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void openBilling()}
                  >
                    {t("settings:billingManage")}
                  </Button>
                }
              />
            ) : null}
          </>
        )}
      </SettingsCard>
      {billing?.available ? (
        <p className="text-ui-sm text-muted-foreground">
          {sandbox ? t("settings:billingSandboxNote") : t("settings:billingPolarNote")}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SettingsSectionShell>
  );
}

function subscriptionDescription(status: AccountBillingStatus): string {
  const sandbox = status.environment === "sandbox";
  if (status.cancelAtPeriodEnd && status.validUntil) {
    return `${t("settings:billingEnds", {
      date: new Date(status.validUntil).toLocaleDateString(),
    })}${sandbox ? t("settings:billingNoRealPaymentsSuffix") : ""}`;
  }
  if (status.access === "granted") {
    return sandbox ? t("settings:billingAccessConfirmed") : t("settings:billingLocalFree");
  }
  return sandbox ? t("settings:billingTryTestBilling") : t("settings:billingLocalFree");
}
