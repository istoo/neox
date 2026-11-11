import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

interface LibraryEditorSheetProps {
  visible: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave: () => Promise<void>;
  saveDisabled?: boolean;
  removeLabel?: string;
  onRemove?: () => void;
}

/** A settings sheet with the same cancel/save rail for every Library editor. */
export function LibraryEditorSheet({
  visible,
  title,
  children,
  onClose,
  onSave,
  saveDisabled,
  removeLabel,
  onRemove,
}: LibraryEditorSheetProps) {
  const { t } = useTranslation();
  const [isPending, setIsPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setIsPending(false);
      setSubmitError(null);
    }
  }, [visible]);

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);

  const handleClose = useCallback(() => {
    if (!isPending) {
      onClose();
    }
  }, [isPending, onClose]);

  const handleSave = useCallback(async () => {
    setIsPending(true);
    setSubmitError(null);
    try {
      await onSave();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPending(false);
    }
  }, [onSave]);

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={handleClose}>
      <View style={styles.body}>
        {children}
        {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
        {removeLabel && onRemove ? (
          <Button variant="outline" onPress={onRemove}>
            {removeLabel}
          </Button>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={onClose}
            disabled={isPending}
          >
            {t("settings.usePages.library.common.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSave}
            disabled={isPending || saveDisabled}
          >
            {isPending
              ? t("settings.usePages.library.common.saving")
              : t("settings.usePages.library.common.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
