/* eslint-disable react-perf/jsx-no-new-function-as-prop -- a settings list is not a hot list; each row's remove closure is created once per value. */
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";

/** A list of strings edited one row at a time: add, remove, keep order. */
export function StringListEditor({
  label,
  hint,
  addLabel,
  removeLabel,
  placeholder,
  values,
  validate,
  invalidMessage,
  onChange,
}: {
  label: string;
  hint: string;
  addLabel: string;
  removeLabel: string;
  placeholder: string;
  values: readonly string[];
  validate: (value: string) => boolean;
  invalidMessage: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<EditingTextInputHandle>(null);

  const add = useCallback(() => {
    const value = (input.current?.getText() ?? draft).trim();
    if (value.length === 0) {
      return;
    }
    if (!validate(value)) {
      setError(invalidMessage);
      return;
    }
    if (values.includes(value)) {
      setError(null);
      input.current?.replaceText("");
      setDraft("");
      return;
    }
    setError(null);
    input.current?.replaceText("");
    setDraft("");
    onChange([...values, value]);
  }, [draft, invalidMessage, onChange, validate, values]);

  const remove = useCallback(
    (value: string) => {
      setError(null);
      onChange(values.filter((entry) => entry !== value));
    },
    [onChange, values],
  );

  const rows = useMemo(
    () =>
      values.map((value) => (
        <SettingsRow key={value} label={value}>
          <Button variant="ghost" size="sm" onPress={() => remove(value)}>
            {removeLabel}
          </Button>
        </SettingsRow>
      )),
    [remove, removeLabel, values],
  );

  return (
    <>
      <SettingsRow label={label} hint={hint} error={error ?? undefined}>
        <TextInput
          ref={input}
          initialValue=""
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={styles.input}
          accessibilityLabel={label}
        />
        <Button variant="outline" size="sm" onPress={add}>
          {addLabel}
        </Button>
      </SettingsRow>
      {rows}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  input: { minWidth: 220 },
}));
