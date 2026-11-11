import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { RateWindowDraft } from "./providers-helpers";

/** Sunday first, as myna's chips and the wire's `days` are numbered. */
const DAY_KEYS = ["daySun", "dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat"] as const;

const MAX_WINDOWS = 8;

/** Every half hour of the day, as myna's picker offers them; an end may be 24:00. */
function halfHours(end: boolean): string[] {
  const times: string[] = [];
  for (let minutes = 0; minutes < 1440; minutes += 30) {
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const rest = String(minutes % 60).padStart(2, "0");
    times.push(`${hours}:${rest}`);
  }
  if (end) {
    times.push("24:00");
  }
  return times;
}

const START_TIMES = halfHours(false);
const END_TIMES = halfHours(true);

interface TimeOptionProps {
  time: string;
  onPick: (time: string) => void;
}

function TimeOption({ time, onPick }: TimeOptionProps) {
  const handleSelect = useCallback(() => onPick(time), [onPick, time]);
  return <DropdownMenuItem onSelect={handleSelect}>{time}</DropdownMenuItem>;
}

interface TimePickerProps {
  value: string;
  options: readonly string[];
  label: string;
  onPick: (time: string) => void;
}

function TimePicker({ value, options, label, onPick }: TimePickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.timeTrigger}
      >
        <Text style={styles.timeText}>{value.length > 0 ? value : "--:--"}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map((time) => (
          <TimeOption key={time} time={time} onPick={onPick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DayChipProps {
  label: string;
  day: number;
  selected: boolean;
  onToggle: (day: number) => void;
}

function DayChip({ label, day, selected, onToggle }: DayChipProps) {
  const handlePress = useCallback(() => onToggle(day), [day, onToggle]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      style={[styles.dayChip, selected ? styles.dayChipOn : null]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
    >
      <Text style={[styles.dayChipText, selected ? styles.dayChipTextOn : null]}>{label}</Text>
    </PressHighlight>
  );
}

interface RateWindowRowProps {
  window: RateWindowDraft;
  index: number;
  onChange: (index: number, next: RateWindowDraft) => void;
  onRemove: (index: number) => void;
}

function RateWindowRow({ window, index, onChange, onRemove }: RateWindowRowProps) {
  const { t } = useTranslation();
  const handleStartPick = useCallback(
    (time: string) => onChange(index, { ...window, start: time }),
    [index, onChange, window],
  );
  const handleEndPick = useCallback(
    (time: string) => onChange(index, { ...window, end: time }),
    [index, onChange, window],
  );
  const handleRate = useCallback(
    (text: string) => onChange(index, { ...window, rate: text }),
    [index, onChange, window],
  );
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const handleDay = useCallback(
    (day: number) => {
      const days = window.days.includes(day)
        ? window.days.filter((entry) => entry !== day)
        : [...window.days, day].sort((a, b) => a - b);
      onChange(index, { ...window, days });
    },
    [index, onChange, window],
  );

  return (
    <View style={styles.window}>
      <View style={styles.days}>
        {DAY_KEYS.map((key, day) => (
          <DayChip
            key={key}
            label={t(`settings.gatewayPages.providers.${key}`)}
            day={day}
            selected={window.days.includes(day)}
            onToggle={handleDay}
          />
        ))}
      </View>
      <View style={styles.times}>
        <TimePicker
          value={window.start}
          options={START_TIMES}
          label={t("settings.gatewayPages.providers.rateWindowStart")}
          onPick={handleStartPick}
        />
        <Text style={styles.dash}>–</Text>
        <TimePicker
          value={window.end}
          options={END_TIMES}
          label={t("settings.gatewayPages.providers.rateWindowEnd")}
          onPick={handleEndPick}
        />
        <View style={styles.rateField}>
          <FormTextInput
            size="sm"
            initialValue={window.rate}
            onChangeText={handleRate}
            placeholder="3"
            keyboardType="decimal-pad"
            accessibilityLabel={t("settings.gatewayPages.providers.rateWindowRate")}
          />
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onPress={handleRemove}
          accessibilityLabel={t("settings.gatewayPages.providers.rateWindowRemove")}
        />
      </View>
    </View>
  );
}

export interface RateWindowsEditorProps {
  windows: RateWindowDraft[];
  onChange: (windows: RateWindowDraft[]) => void;
  /** Why the windows could not be saved, when they could not. */
  error?: string;
}

/** A provider's time-of-day multipliers, myna's rate windows. */
export function RateWindowsEditor({ windows, onChange, error }: RateWindowsEditorProps) {
  const { t } = useTranslation();
  const handleAdd = useCallback(
    () => onChange([...windows, { days: [], start: "", end: "", rate: "" }]),
    [onChange, windows],
  );
  const handleChange = useCallback(
    (index: number, next: RateWindowDraft) =>
      onChange(windows.map((window, position) => (position === index ? next : window))),
    [onChange, windows],
  );
  const handleRemove = useCallback(
    (index: number) => onChange(windows.filter((_, position) => position !== index)),
    [onChange, windows],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{t("settings.gatewayPages.providers.rateWindows")}</Text>
      {windows.map((window, index) => (
        <RateWindowRow
          // The fields are uncontrolled: remounting a row when one is added
          // or removed is what keeps each box showing its own window.
          // eslint-disable-next-line react/no-array-index-key -- see above
          key={`${index}:${windows.length}`}
          window={window}
          index={index}
          onChange={handleChange}
          onRemove={handleRemove}
        />
      ))}
      {windows.length < MAX_WINDOWS ? (
        <View style={styles.addRow}>
          <Button variant="ghost" size="sm" leftIcon={Plus} onPress={handleAdd}>
            {t("settings.gatewayPages.providers.rateWindowAdd")}
          </Button>
        </View>
      ) : null}
      <Text style={styles.hint}>{t("settings.gatewayPages.providers.rateWindowsHint")}</Text>
      {error === undefined ? null : <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  window: {
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  days: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  dayChip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
  },
  dayChipOn: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  dayChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  dayChipTextOn: {
    color: theme.colors.foreground,
  },
  times: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  timeTrigger: {
    width: 84,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  timeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rateField: {
    width: 64,
  },
  dash: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  addRow: {
    flexDirection: "row",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
