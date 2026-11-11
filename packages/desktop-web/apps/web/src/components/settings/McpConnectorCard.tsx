import type { McpConnector } from "@synara/contracts";
import type { ReactNode } from "react";

import { McpConnectorGlyph } from "./McpConnectorGlyph";
import { useTranslation } from "~/i18n";

export const MCP_CONNECTOR_CARD_CLASS_NAME =
  "min-w-0 rounded-xl border border-border bg-[var(--color-background-elevated-primary)] p-4 text-ui";

/** Shared identity for saved connectors and chat proposals. */
export function McpConnectorCardHeader(props: {
  connector: McpConnector;
  subtitle?: string | undefined;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { connector } = props;
  const local = connector.transport === "stdio" || connector.transport === "local-http";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <McpConnectorGlyph name={connector.name} url={local ? undefined : connector.url} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-ui-lg font-semibold" title={connector.name}>
            {connector.name}
          </span>
          {connector.presetId === null ? (
            <span className="shrink-0 rounded-md border border-border/60 px-1.5 text-ui-xs text-muted-foreground">
              {t("settings:connections_mcpCustom")}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-ui-sm text-muted-foreground">
          {props.subtitle ??
            (local
              ? t("settings:connections_mcpOnThisComputer")
              : t("settings:connections_mcpRemoteServer"))}
        </p>
      </div>
      {props.children}
    </div>
  );
}

/** Exact configuration stays reviewable without putting paths on the main card. */
export function McpConnectorDetails({ connector }: { connector: McpConnector }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-ui-sm">
      <dl className="space-y-3 [overflow-wrap:anywhere]">
        {connector.transport === "stdio" ? (
          <>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:connections_mcpCommand")}
              </dt>
              <dd>
                <code>{connector.command}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:connections_mcpArgumentsExact")}
              </dt>
              <dd>
                <code>{JSON.stringify(connector.args)}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:connections_mcpWorkingDirectory")}
              </dt>
              <dd>{connector.cwd ?? t("settings:connections_mcpHomeDirectory")}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:connections_mcpEnvKeys")}
              </dt>
              <dd>{connector.envKeys.join(", ") || t("settings:connections_mcpNone")}</dd>
            </div>
          </>
        ) : (
          <div className="space-y-1">
            <dt className="text-ui-xs text-muted-foreground">
              {t("settings:connections_mcpServerUrl")}
            </dt>
            <dd>{connector.url}</dd>
          </div>
        )}
      </dl>
      <p className="text-ui-xs text-muted-foreground">{t("settings:connections_mcpUsedBy")}</p>
    </div>
  );
}
