import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentConnectProfile } from "@neolix/protocol/agent-connect";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";

function SaveCurrentButton({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <PressHighlight
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t("settings.usePages.agent.saveCurrent")}
      style={styles.saveButton}
    >
      <Text style={styles.saveText}>{t("settings.usePages.agent.saveCurrent")}</Text>
    </PressHighlight>
  );
}

interface ProfileRowProps {
  profile: AgentConnectProfile;
  saving: boolean;
  onApply: (name: string) => void;
  onOverwrite: (name: string) => void;
  onDelete: (name: string) => void;
  onRename: (name: string, to: string) => void;
}

function ProfileRow({
  profile,
  saving,
  onApply,
  onOverwrite,
  onDelete,
  onRename,
}: ProfileRowProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [resetKey, setResetKey] = useState(0);
  const apply = useCallback(() => {
    onApply(profile.name);
  }, [onApply, profile.name]);
  const overwrite = useCallback(() => {
    onOverwrite(profile.name);
  }, [onOverwrite, profile.name]);
  const remove = useCallback(() => {
    onDelete(profile.name);
  }, [onDelete, profile.name]);
  const startRename = useCallback(() => {
    setName(profile.name);
    setResetKey((key) => key + 1);
    setRenaming(true);
  }, [profile.name]);
  const cancelRename = useCallback(() => {
    setRenaming(false);
  }, []);
  const submitRename = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed !== profile.name) onRename(profile.name, trimmed);
    setRenaming(false);
  }, [name, onRename, profile.name]);
  if (renaming) {
    return (
      <View style={styles.profileRow}>
        <View style={styles.namingField}>
          <FormTextInput
            initialValue={profile.name}
            resetKey={resetKey}
            onChangeText={setName}
            placeholder={t("settings.usePages.agent.profileNamePlaceholder")}
            accessibilityLabel={t("settings.usePages.agent.profileName")}
            autoFocus
          />
        </View>
        <Button size="sm" onPress={submitRename} disabled={name.trim().length === 0 || saving}>
          {t("settings.usePages.agent.profileSave")}
        </Button>
        <Button size="sm" variant="ghost" onPress={cancelRename} disabled={saving}>
          {t("settings.usePages.agent.profileCancel")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.profileRow}>
      <View style={styles.profileTitle}>
        {profile.inUse === true ? (
          <Text style={styles.inUse}>{t("settings.usePages.agent.profileInUse")}</Text>
        ) : null}
        <Text style={styles.profileName} numberOfLines={1}>
          {profile.name}
        </Text>
        {profile.library === undefined ? null : (
          <Text style={styles.libraryTag}>{t("settings.usePages.agent.profileLibrary")}</Text>
        )}
      </View>
      <View style={styles.profileActions}>
        <Button size="sm" variant="outline" onPress={apply} disabled={saving}>
          {t("settings.usePages.agent.profileApply")}
        </Button>
        <Button size="sm" variant="ghost" onPress={overwrite} disabled={saving}>
          {t("settings.usePages.agent.profileUpdate")}
        </Button>
        <Button size="sm" variant="ghost" onPress={startRename} disabled={saving}>
          {t("settings.usePages.agent.profileRename")}
        </Button>
        <PressHighlight
          onPress={remove}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t("settings.usePages.agent.profileDeleteNamed", {
            name: profile.name,
          })}
          style={styles.deleteButton}
        >
          <Text style={styles.deleteText}>{t("settings.usePages.agent.profileDelete")}</Text>
        </PressHighlight>
      </View>
    </View>
  );
}

interface AgentProfilesProps {
  profiles: AgentConnectProfile[];
  saving: boolean;
  onSave: (name: string) => void;
  onApply: (name: string) => void;
  onOverwrite: (name: string) => void;
  onDelete: (name: string) => void;
  onRename: (name: string, to: string) => void;
  testID?: string;
}

/** Saved setups ("profiles"): the switch states and models, applied in one click. */
export function AgentProfiles({
  profiles,
  saving,
  onSave,
  onApply,
  onOverwrite,
  onDelete,
  onRename,
  testID,
}: AgentProfilesProps) {
  const { t } = useTranslation();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [resetKey, setResetKey] = useState(0);

  const startNaming = useCallback(() => {
    setName("");
    setResetKey((key) => key + 1);
    setNaming(true);
  }, []);
  const cancel = useCallback(() => {
    setNaming(false);
    setName("");
  }, []);
  const submit = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(trimmed);
    setNaming(false);
    setName("");
  }, [name, onSave]);
  const changeName = useCallback((value: string) => {
    setName(value);
  }, []);
  const deleteProfile = useCallback(
    async (profileName: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.agent.profileDeleteTitle", { name: profileName }),
        message: t("settings.usePages.agent.profileDeleteMessage"),
        confirmLabel: t("settings.usePages.agent.profileDelete"),
        destructive: true,
      });
      if (confirmed) onDelete(profileName);
    },
    [onDelete, t],
  );
  const overwriteProfile = useCallback(
    async (profileName: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.agent.profileUpdateTitle", { name: profileName }),
        message: t("settings.usePages.agent.profileUpdateMessage"),
        confirmLabel: t("settings.usePages.agent.profileUpdate"),
      });
      if (confirmed) onOverwrite(profileName);
    },
    [onOverwrite, t],
  );

  const saveButton = useMemo(
    () => <SaveCurrentButton disabled={saving} onPress={startNaming} />,
    [saving, startNaming],
  );

  return (
    <SettingsSection
      title={t("settings.usePages.agent.profilesTitle")}
      trailing={saveButton}
      testID={testID ?? "agent-profiles"}
      style={styles.section}
    >
      {naming ? (
        <View style={[settingsStyles.card, styles.namingRow]}>
          <View style={styles.namingField}>
            <FormTextInput
              initialValue=""
              resetKey={resetKey}
              onChangeText={changeName}
              placeholder={t("settings.usePages.agent.profileNamePlaceholder")}
              accessibilityLabel={t("settings.usePages.agent.profileName")}
              autoFocus
            />
          </View>
          <Button size="sm" onPress={submit} disabled={name.trim().length === 0 || saving}>
            {t("settings.usePages.agent.profileSave")}
          </Button>
          <Button size="sm" variant="ghost" onPress={cancel} disabled={saving}>
            {t("settings.usePages.agent.profileCancel")}
          </Button>
        </View>
      ) : null}
      {profiles.length === 0 ? (
        <Text style={styles.hint}>{t("settings.usePages.agent.profilesHint")}</Text>
      ) : (
        <View style={[settingsStyles.card, styles.profileCard]}>
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.name}
              profile={profile}
              saving={saving}
              onApply={onApply}
              onOverwrite={overwriteProfile}
              onDelete={deleteProfile}
              onRename={onRename}
            />
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginTop: theme.spacing[4],
  },
  saveButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  saveText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  namingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  namingField: {
    flex: 1,
    minWidth: 120,
  },
  profileCard: {
    paddingVertical: theme.spacing[1],
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  profileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
    minWidth: 0,
  },
  profileTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  inUse: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
  },
  libraryTag: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  profileActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  deleteButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  deleteText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
