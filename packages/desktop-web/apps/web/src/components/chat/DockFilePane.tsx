// FILE: DockFilePane.tsx
// Purpose: Right-dock pane that previews one workspace file through the shared
//          WorkspaceFilePreview. Markdown opens already parsed (rendered); the
//          shared header carries the source toggle and open-in-editor controls.
// Layer: Chat right-dock UI
// Exports: DockFilePane

import { useMemo } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { useAppSettings } from "~/appSettings";
import { useRunningPlugins } from "~/plugins/catalog";
import { buildPluginContributionIndex } from "~/plugins/contributions";
import { fileBasename, resolveFilePanelEntry } from "~/plugins/pluginPanels.logic";
import { PluginViewHost } from "~/plugins/PluginViewHost";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";
import { useTranslation } from "~/i18n";

export function DockFilePane(props: {
  workspaceRoot: string | null;
  filePath: string | null;
  isVisible: boolean;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const runningPlugins = useRunningPlugins();
  const filePanels = useMemo(
    () => buildPluginContributionIndex(runningPlugins).filePanels,
    [runningPlugins],
  );
  const panel = useMemo(() => {
    if (!props.filePath) return null;
    return resolveFilePanelEntry({
      path: props.filePath,
      panels: filePanels,
      associations: settings.filePanelAssociations,
    });
  }, [filePanels, props.filePath, settings.filePanelAssociations]);
  const panelPlugin = panel
    ? runningPlugins.find((plugin) => plugin.id === panel.pluginId)
    : undefined;
  const panelView = panel
    ? panelPlugin?.web?.views.find((view) => view.id === panel.contribution.view)
    : undefined;

  if (props.filePath && panel && panelPlugin && panelView) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {fileBasename(props.filePath)}
          </span>
          <span className="ml-auto shrink-0 text-ui-sm text-muted-foreground">
            {panel.contribution.title}
          </span>
        </div>
        <PluginViewHost
          plugin={panelPlugin}
          viewId={panelView.id}
          params={{ path: props.filePath, workspaceRoot: props.workspaceRoot ?? "" }}
          fill
          className="min-h-0 flex-1"
        />
      </div>
    );
  }

  return (
    <WorkspaceFilePreview
      workspaceRoot={props.workspaceRoot}
      filePath={props.filePath}
      liveRevalidationEnabled={props.isVisible}
      markdownPreviewDefault
      emptyState={
        <PanelStateMessage density="compact" fill="flex">
          <p>{t("chat:clickAFileInTheChatToPreviewIt")}</p>
        </PanelStateMessage>
      }
      onReferenceInChat={props.onReferenceInChat}
      onAskWhyInChat={props.onAskWhyInChat}
      onCommentInChat={props.onCommentInChat}
    />
  );
}
