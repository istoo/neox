import { ProjectCatalogDialog } from "./ProjectCatalogDialog";
import { readRecoverableEditorDrafts } from "~/lib/hosts/editorRecovery";
import { readUnsavedExecutionDrafts } from "~/lib/hosts/executionSwitch";
import { ensureNativeApi } from "~/nativeApi";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { deactivateHost } from "~/lib/hosts/activeHost";
import { addWsTransportStateListener, type WsTransportState } from "~/wsTransportEvents";
import { ServerIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuItem, MenuSeparator } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { toastManager } from "../ui/toast";
import { useTranslation } from "~/i18n";

/** Execution destination is visible independently of account and cloud state. */
export function HostConnectionControl({ compact: compactProp }: { compact?: boolean }) {
  const compact = compactProp ?? false;
  const { t } = useTranslation();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const context = readExecutionContext();
  const navigate = useNavigate();
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  if (!context) return null;
  const label = context.remote ? context.execution.label : t("settings:connections_thisComputer");
  const channel = context.remote?.channel ?? context.controller.channel;
  const destination = channel
    ? `${label} · ${channel === "dev" ? "Development" : `Neox ${channel[0]!.toUpperCase()}${channel.slice(1)}`}`
    : label;
  const status =
    state === "open"
      ? t("settings:connections_connected")
      : state === "connecting"
        ? t("settings:connections_connecting")
        : state === "incompatible"
          ? t("settings:connections_updateRequired")
          : t("settings:connections_connectionUnavailable");
  const back = () => {
    try {
      deactivateHost();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:connections_couldNotPreserveDrafts"),
        description:
          error instanceof Error ? error.message : t("settings:connections_copyUnsavedText"),
      });
    }
  };
  const exportDrafts = async () => {
    try {
      const recovered = readRecoverableEditorDrafts();
      const current = readUnsavedExecutionDrafts();
      if (!current.length) {
        if (!recovered.length) {
          toastManager.add({
            type: "info",
            title: t("settings:connections_noDraftsToRecover"),
          });
          return;
        }
      }
      const saveFile = ensureNativeApi().dialogs.saveFile;
      if (!saveFile) {
        toastManager.add({
          type: "error",
          title: t("settings:connections_couldNotExportDrafts"),
          description: t("settings:connections_fileExportUnavailable"),
        });
        return;
      }
      await saveFile({
        defaultFilename: "synara-editor-drafts.json",
        contents: JSON.stringify(
          { environmentId: context.execution.environmentId, host: label, current, recovered },
          null,
          2,
        ),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:connections_couldNotExportDrafts"),
        description: error instanceof Error ? error.message : t("settings:connections_tryAgain"),
      });
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size={compact ? "icon" : "sm"}
              className={
                compact
                  ? "size-9"
                  : "h-auto sm:h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
              }
              aria-label={`${destination}. ${status}`}
              title={`${destination}. ${status}`}
            />
          }
        >
          <ServerIcon className="size-4 shrink-0" />
          {!compact ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-sm">{destination}</span>
              <span className="block text-ui-xs text-muted-foreground">{status}</span>
            </span>
          ) : null}
        </MenuTrigger>
        <ComposerPickerMenuPopup side={compact ? "right" : "top"} align="start" className="w-64">
          <div className="px-2 py-1.5">
            <p className="truncate text-ui font-medium">{destination}</p>
            <p className="text-ui-sm text-muted-foreground">{status}</p>
          </div>
          {context.remote ? (
            <>
              <MenuItem onClick={back}>{t("settings:connections_backToThisComputer")}</MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => setCatalogOpen(true)}>
            {t("settings:connections_linkedProjects")}
          </MenuItem>
          <MenuItem onClick={() => void exportDrafts()}>
            {t("settings:connections_exportEditorDrafts")}
          </MenuItem>
          <MenuItem
            onClick={() => void navigate({ to: "/settings", search: { section: "connections" } })}
          >
            {t("settings:connections_manageConnections")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {catalogOpen ? <ProjectCatalogDialog onClose={() => setCatalogOpen(false)} /> : null}
    </>
  );
}
