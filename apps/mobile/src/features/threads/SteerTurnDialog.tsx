import type { EnvironmentId, OrchestrationSession, ThreadId, TurnId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { cn } from "../../lib/cn";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveMobileSteering } from "./steer-turn";

export function SteerTurnDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession | null;
  readonly disabled: boolean;
}) {
  const steerTurn = useAtomCommand(threadEnvironment.steerTurn, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [targetTurnId, setTargetTurnId] = useState<TurnId | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const state = resolveMobileSteering({ ...props, targetTurnId, text, submitting });
  const close = () => {
    if (!inFlight.current) setOpen(false);
  };
  const submit = async () => {
    if (!state.submission || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await steerTurn({
        environmentId: props.environmentId,
        input: state.submission,
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not submit steering.");
        return;
      }
      setText("");
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not submit steering.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      {state.activeTurnId !== null ? (
        <View className="items-end">
          <ComposerInlineControl
            label="Steer active turn"
            accessibilityHint="Send an instruction to this running Codex turn without queuing a new turn"
            showChevron={false}
            disabled={props.disabled || submitting}
            onPress={() => {
              setTargetTurnId(state.activeTurnId);
              setError(null);
              setOpen(true);
            }}
          />
        </View>
      ) : null}
      <Modal animationType="fade" transparent visible={open} onRequestClose={close}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          className="flex-1 justify-center bg-backdrop px-5"
        >
          <ScrollView
            contentContainerClassName="flex-grow justify-center"
            keyboardShouldPersistTaps="handled"
          >
            <View
              accessibilityViewIsModal
              className="gap-4 rounded-2xl border border-border bg-sheet p-5"
            >
              <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
                Steer active turn
              </Text>
              <Text className="text-sm leading-5 text-foreground-secondary">
                Send an instruction to this running Codex turn. Its model and permissions stay
                unchanged. This does not queue another turn.
              </Text>
              <TextInput
                accessibilityLabel="Steering instruction"
                autoFocus
                multiline
                scrollEnabled
                textAlignVertical="top"
                editable={!submitting}
                value={text}
                onChangeText={setText}
                placeholder="Instruction for this turn"
                className="min-h-32 max-h-64 rounded-xl"
              />
              {!state.targetIsRunning ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                  This turn is no longer running. Close and reopen to choose another turn.
                </Text>
              ) : props.disabled ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                  Reconnect to the environment or finish the current edit before steering.
                </Text>
              ) : null}
              {error ? (
                <Text
                  accessibilityRole="alert"
                  accessibilityLiveRegion="assertive"
                  className="text-sm text-danger"
                >
                  {error}
                </Text>
              ) : null}
              <View className="gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: submitting }}
                  disabled={submitting}
                  onPress={close}
                  className={cn(
                    "min-h-11 items-center justify-center rounded-xl border border-border px-4",
                    submitting && "opacity-50",
                  )}
                >
                  <Text className="font-t3-medium text-sm">Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !state.submission, busy: submitting }}
                  disabled={!state.submission}
                  onPress={() => void submit()}
                  className={cn(
                    "min-h-11 items-center justify-center rounded-xl border border-accent bg-accent px-4",
                    !state.submission && "opacity-50",
                  )}
                >
                  <Text className="font-t3-medium text-sm text-white">
                    {submitting ? "Submitting…" : "Send instruction"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
