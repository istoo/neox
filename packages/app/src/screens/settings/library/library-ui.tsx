import { useCallback, useMemo, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { LibraryProblem } from "@neolix/protocol/library";
import { useProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

interface AgentIconProps {
  agent: string;
  size: number;
  color: string;
}

function AgentIconView({ agent, size, color }: AgentIconProps) {
  const Icon: ProviderIconComponent = useProviderIcon(agent);
  return <Icon size={size} color={color} />;
}

const ThemedAgentIcon = withUnistyles(AgentIconView, (theme: Theme) => ({
  color: theme.colors.foreground,
}));

export function AgentIcon({ agent, size = 18 }: { agent: string; size?: number }) {
  return <ThemedAgentIcon agent={agent} size={size} />;
}

interface ServerIconProps {
  icon?: string;
  size: number;
  color: string;
}

function ServerIconView({ icon, size, color }: ServerIconProps) {
  const imageStyle = useMemo(() => ({ width: size, height: size, borderRadius: 4 }), [size]);
  const source = useMemo(() => (icon ? { uri: icon } : null), [icon]);
  if (!source) {
    return <Server size={size} color={color} />;
  }
  return <Image source={source} style={imageStyle} accessibilityIgnoresInvertColors />;
}

const ThemedServerIcon = withUnistyles(ServerIconView, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** A market or library server's icon; a plain server glyph without one. */
export function ServerIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  return <ThemedServerIcon icon={icon} size={size} />;
}

interface AgentChipProps {
  agent: string;
  name: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: (agent: string) => void;
}

function ChipBody({ agent, name, selected, disabled, onToggle }: AgentChipProps) {
  const handlePress = useCallback(() => {
    if (!disabled) {
      onToggle(agent);
    }
  }, [agent, disabled, onToggle]);
  const chipStyle = useMemo(
    () => [styles.chip, selected && styles.chipSelected, disabled && styles.chipDisabled],
    [disabled, selected],
  );
  const labelStyle = useMemo(
    () => [styles.chipLabel, selected && styles.chipLabelSelected],
    [selected],
  );
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  return (
    <PressHighlight
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={chipStyle}
    >
      <ThemedAgentIcon agent={agent} size={14} />
      <Text style={labelStyle}>{name}</Text>
    </PressHighlight>
  );
}

/** The agents an item is given to: a chip each, pressed to switch it on or off. */
export function AgentChips({
  agents,
  selected,
  disabled,
  onToggle,
}: {
  agents: { id: string; name: string }[];
  selected: readonly string[];
  disabled?: boolean;
  onToggle: (agentId: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {agents.map((agent) => (
        <ChipBody
          key={agent.id}
          agent={agent.id}
          name={agent.name}
          selected={selected.includes(agent.id)}
          disabled={disabled}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

export function LibraryEmpty({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{text}</Text>
      {actionLabel && onAction ? (
        <Button variant="outline" onPress={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}

export function LibraryProblems({ problems }: { problems: LibraryProblem[] }) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <View style={styles.problems}>
      {problems.slice(0, 3).map((problem) => (
        <Text key={`${problem.agent}:${problem.what}`} style={styles.problemText}>
          {problem.agent}: {problem.error}
        </Text>
      ))}
    </View>
  );
}

export function LibraryIntro({ children }: { children: ReactNode }) {
  return <Text style={styles.intro}>{children}</Text>;
}

export function LibraryRowHeader({ label, note }: { label: string; note?: string }) {
  return (
    <View style={styles.rowHeader}>
      <Text style={settingsStyles.sectionHeaderTitle}>{label}</Text>
      {note ? <Text style={styles.rowHeaderNote}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  chipSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface3,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chipLabelSelected: {
    color: theme.colors.foreground,
  },
  empty: {
    alignItems: "center",
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    maxWidth: 460,
  },
  intro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  problems: {
    borderWidth: 1,
    borderColor: theme.colors.statusWarning,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    marginBottom: theme.spacing[4],
  },
  problemText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  rowHeaderNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

export { styles as libraryUiStyles };
