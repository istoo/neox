import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibraryInstructionsView } from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { LibrarySnapshot, LibrarySyncResult } from "@neolix/protocol/library";
import { LibraryEditorSheet } from "./library-editor";

type AgentView = LibraryInstructionsView["agents"][number];

export function AgentInstructionsSheet({
  view,
  client,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  view: AgentView;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [extra, setExtra] = useState(view.extra);
  const [busy, setBusy] = useState(false);

  const finish = useCallback(
    (result: { library: LibrarySnapshot; result: LibrarySyncResult }) => {
      onLibrary(result.library);
      onSaved(result.result);
      onClose();
    },
    [onClose, onLibrary, onSaved],
  );

  const save = useCallback(async () => {
    const result = await client.saveLibraryInstructions({ extra: { [view.agent]: extra } });
    onLibrary(result.library);
    onSaved(result.result);
  }, [client, extra, onLibrary, onSaved, view.agent]);

  const run = useCallback(
    (change: { importOwn?: string[]; rewrite?: string[] }) => {
      setBusy(true);
      void (async () => {
        try {
          const result = await client.saveLibraryInstructions(change);
          finish(result);
        } catch (error) {
          onError(error);
        } finally {
          setBusy(false);
        }
      })();
    },
    [client, finish, onError],
  );

  const moveOwn = useCallback(() => run({ importOwn: [view.agent] }), [run, view.agent]);
  const rewrite = useCallback(() => run({ rewrite: [view.agent] }), [run, view.agent]);

  return (
    <LibraryEditorSheet
      visible
      title={t("settings.usePages.library.agentInstructions.title", { name: view.name })}
      onClose={onClose}
      onSave={save}
      saveDisabled={busy}
    >
      <Field
        label={t("settings.usePages.library.agentInstructions.extra", { name: view.name })}
        hint={t("settings.usePages.library.agentInstructions.extraPlaceholder")}
      >
        <FormTextInput initialValue={extra} onChangeText={setExtra} multiline autoCorrect={false} />
      </Field>
      {view.override ? (
        <Text style={styles.warning}>
          {t("settings.usePages.library.agentInstructions.overrideWarning", {
            path: view.override,
          })}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button variant="outline" onPress={moveOwn} disabled={busy}>
          {t("settings.usePages.library.agentInstructions.moveOwn")}
        </Button>
        <Button variant="outline" onPress={rewrite} disabled={busy}>
          {t("settings.usePages.library.agentInstructions.rewrite")}
        </Button>
      </View>
    </LibraryEditorSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  warning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
