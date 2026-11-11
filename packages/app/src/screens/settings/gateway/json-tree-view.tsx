import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-api-context";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { jsonNodeOpen, rememberJsonNode } from "./json-tree-fold";

/**
 * myna's JSON tree (plugins/gateway/client.js jsonTree): objects and arrays
 * fold at their bracket, their parts in order; a primitive is its JSON. A
 * request, a response and a streamed reply all draw with it. A node the
 * reader never folded is open, and what they fold is kept by the body's key
 * and the node's path, across the tab switches a redraw brings. A value has
 * a Copy value button (on hover, always on touch), and a key copies itself
 * on a click while a drag still selects the text, as myna's do.
 */

type CopyText = (text: string) => void;

const ThemedCopy = withUnistyles(Copy);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function JsonTreeView({ value, stateKey }: { value: unknown; stateKey: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const copy = useCallback<CopyText>(
    (text) => {
      void copyToClipboard(text).then(() => toast.copied());
    },
    [toast],
  );
  return (
    <JsonNode
      value={value}
      name={null}
      path=""
      stateKey={stateKey}
      copy={copy}
      copyLabel={t("common.actions.copy")}
      alwaysShowCopy={isNative || isCompact}
    />
  );
}

interface JsonNodeProps {
  value: unknown;
  name: string | null;
  path: string;
  stateKey: string;
  copy: CopyText;
  copyLabel: string;
  /** Touch and compact layouts have no hover, so their copy buttons stay out. */
  alwaysShowCopy: boolean;
}

function JsonNode(props: JsonNodeProps) {
  return isContainer(props.value) ? (
    <JsonBranch {...props} value={props.value} />
  ) : (
    <JsonPrimitive {...props} />
  );
}

function JsonPrimitive({ value, name, copy, copyLabel, alwaysShowCopy }: JsonNodeProps) {
  const [hovered, setHovered] = useState(false);
  const showCopy = alwaysShowCopy || hovered;
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const copyValue = useCallback(() => {
    copy(valueCopyText(value));
  }, [copy, value]);
  const copyName = useCallback(() => {
    if (name !== null && !hasTextSelection()) {
      copy(name);
    }
  }, [copy, name]);
  return (
    <View style={styles.row} onPointerEnter={enter} onPointerLeave={leave}>
      {name === null ? null : <KeyText name={name} onPress={copyName} />}
      <Text style={[styles.leaf, styles.value]} selectable>
        {primitiveText(value)}
      </Text>
      <CopySlot show={showCopy} label={copyLabel} onPress={copyValue} />
    </View>
  );
}

function JsonBranch({
  value,
  name,
  path,
  stateKey,
  copy,
  copyLabel,
  alwaysShowCopy,
}: JsonNodeProps & { value: Record<string, unknown> | unknown[] }) {
  const [open, setOpen] = useState(() => jsonNodeOpen(stateKey, path));
  const [hovered, setHovered] = useState(false);
  const showCopy = alwaysShowCopy || hovered;
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      rememberJsonNode(stateKey, path, next);
      return next;
    });
  }, [path, stateKey]);
  const copyValue = useCallback(() => {
    copy(valueCopyText(value));
  }, [copy, value]);
  const copyName = useCallback(() => {
    if (name !== null && !hasTextSelection()) {
      copy(name);
    }
  }, [copy, name]);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const [openBracket, closeBracket] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const expandedState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View>
      <View style={styles.row} onPointerEnter={enter} onPointerLeave={leave}>
        {name === null ? null : <KeyText name={name} onPress={copyName} />}
        <PressHighlight
          onPress={toggle}
          accessibilityRole="button"
          accessibilityState={expandedState}
        >
          <Text style={styles.leaf} selectable>
            {openBracket}
            {open ? "" : ` … ${closeBracket}`}
          </Text>
        </PressHighlight>
        <CopySlot show={showCopy} label={copyLabel} onPress={copyValue} />
      </View>
      {open ? (
        <View style={styles.children}>
          {entries.map(([childKey, child]) => (
            <JsonNode
              key={childKey}
              value={child}
              name={Array.isArray(value) ? null : childKey}
              path={`${path}/${childKey}`}
              stateKey={stateKey}
              copy={copy}
              copyLabel={copyLabel}
              alwaysShowCopy={alwaysShowCopy}
            />
          ))}
          <Text style={styles.leaf}>{closeBracket}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The key is pressable on its own: a click copies it, a drag still selects. */
function KeyText({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <PressHighlight onPress={onPress} accessibilityRole="button">
      <Text style={styles.leaf} selectable>
        {`${JSON.stringify(name)}: `}
      </Text>
    </PressHighlight>
  );
}

/**
 * A fixed slot, so revealing the button on hover never moves the value. The
 * icon mounts only while shown, as a body draws thousands of these.
 */
function CopySlot({ show, label, onPress }: { show: boolean; label: string; onPress: () => void }) {
  return (
    <View
      style={show ? styles.copySlot : styles.copySlotHidden}
      pointerEvents={show ? "auto" : "none"}
    >
      <PressHighlight
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.copyButton}
      >
        {show ? <ThemedCopy size={12} uniProps={mutedIcon} /> : null}
      </PressHighlight>
    </View>
  );
}

/** What Copy value puts on the clipboard: a string as written, else its JSON. */
function valueCopyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** A drag that left text selected is not a click on the key (myna checks this). */
function hasTextSelection(): boolean {
  if (!isWeb || typeof window === "undefined") {
    return false;
  }
  return (window.getSelection()?.toString() ?? "").length > 0;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function primitiveText(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  leaf: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  value: {
    flexShrink: 1,
  },
  copySlot: {
    width: 20,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  copySlotHidden: {
    width: 20,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
  },
  copyButton: {
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  children: {
    paddingLeft: theme.spacing[4],
  },
}));
