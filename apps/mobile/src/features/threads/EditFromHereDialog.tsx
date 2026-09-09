import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";

import type { EditFromHereMode } from "./editFromHere";

export const EDIT_FROM_HERE_ACTION_LABELS = {
  cancel: "Cancel",
  rewind: "Rewind current task",
  branch: "Start new task",
} as const;

interface EditFromHereDialogProps {
  readonly open: boolean;
  readonly initialText: string;
  readonly submitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (mode: EditFromHereMode, editedText: string) => void;
}

export function EditFromHereDialog(props: EditFromHereDialogProps) {
  const [editedText, setEditedText] = useState(props.initialText);

  useEffect(() => {
    if (props.open) {
      setEditedText(props.initialText);
    }
  }, [props.initialText, props.open]);

  const trimmedText = useMemo(() => editedText.trim(), [editedText]);
  const disabled = props.submitting || trimmedText.length === 0;
  const submit = (mode: EditFromHereMode) => {
    if (!disabled) {
      props.onSubmit(mode, trimmedText);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        props.onOpenChange(false);
      }}
      transparent
      visible={props.open}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1 justify-center bg-backdrop px-5"
      >
        <ScrollView
          contentContainerClassName="flex-grow justify-center"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-4 rounded-2xl border border-border bg-sheet p-5">
            <View className="gap-1">
              <Text className="text-xl font-t3-bold text-foreground">Edit from here</Text>
              <Text className="text-sm leading-5 text-foreground-secondary">
                Edit this message, then choose whether to preserve this task or replace its later
                timeline.
              </Text>
            </View>

            <TextInput
              accessibilityLabel="Edited message"
              autoFocus
              editable={!props.submitting}
              multiline
              onChangeText={setEditedText}
              placeholder="Message"
              scrollEnabled
              textAlignVertical="top"
              value={editedText}
              className="min-h-32 rounded-xl"
            />

            {props.submitting ? (
              <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2">
                <SymbolView
                  name={{ ios: "arrow.clockwise", android: "refresh" }}
                  size={14}
                  tintColorClassName="text-foreground-muted"
                  type="monochrome"
                />
                <Text className="flex-1 text-xs text-foreground-muted">
                  Waiting for the server to accept this edit…
                </Text>
              </View>
            ) : (
              <Text className="text-xs leading-4 text-foreground-muted">
                Rewind current task removes this message and everything after it from the current
                timeline before submitting the edit once.
              </Text>
            )}

            <View className="gap-2">
              <ActionButton
                disabled={false}
                label={props.submitting ? "Close" : EDIT_FROM_HERE_ACTION_LABELS.cancel}
                onPress={() => props.onOpenChange(false)}
              />
              <ActionButton
                disabled={disabled}
                label={EDIT_FROM_HERE_ACTION_LABELS.rewind}
                onPress={() => submit("rewind")}
                tone="danger"
              />
              <ActionButton
                disabled={disabled}
                label={EDIT_FROM_HERE_ACTION_LABELS.branch}
                onPress={() => submit("branch")}
                tone="primary"
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ActionButton(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "danger" | "primary";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      className={cn(
        "min-h-11 items-center justify-center rounded-xl border px-4",
        props.tone === "primary" && "border-accent bg-accent",
        props.tone === "danger" && "border-danger",
        props.tone === undefined && "border-border",
        props.disabled && "opacity-50",
      )}
    >
      <Text
        className={cn(
          "font-t3-medium text-sm",
          props.tone === "primary" && "text-white",
          props.tone === "danger" && "text-danger",
          props.tone === undefined && "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
