import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResetCheckState } from "@t3tools/contracts";
import {
  latestResetCheck,
  resetCheckPresentation,
} from "@t3tools/client-runtime/resetCheckPresentation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";

export function ResetCheckPanel({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const atom = serverEnvironment.resetCheck({ environmentId, input: {} });
  const query = useAtomValue(atom);
  const start = useAtomCommand(serverEnvironment.startResetCheck, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelResetCheck, { reportFailure: false });
  const [command, setCommand] = useState<ResetCheckState | null>(null);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = latestResetCheck(Option.getOrNull(AsyncResult.value(query)), command);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => appAtomRegistry.refresh(atom), 3_000);
    return () => clearInterval(timer);
  }, [atom, running]);
  const act = async (action: typeof start) => {
    setSending(true);
    setError(null);
    try {
      const reply = await action({ environmentId, input: {} });
      if (reply._tag === "Success") setCommand(reply.value);
      else
        setError(
          "Could not reach the reset checker. Reconnect or update this computer's T3 server.",
        );
      appAtomRegistry.refresh(atom);
    } finally {
      setSending(false);
    }
  };
  const presentation = resetCheckPresentation(state);
  const finding = state?.result;
  return (
    <View className="gap-3 rounded-lg border border-subtle p-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="min-h-11 flex-row items-center gap-2">
          <View
            className={`size-2 rounded-full ${running ? "bg-amber-500" : "bg-foreground-muted"}`}
          />
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {running
              ? "Luna is checking X…"
              : sending
                ? "Contacting Luna…"
                : "Check Tibo's latest posts"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={sending || (!running && (query._tag === "Failure" || state === null))}
          onPress={() => void act(running ? cancel : start)}
          className="min-h-11 justify-center rounded-md border border-subtle px-3"
        >
          <Text className="text-sm text-foreground">
            {running ? "Cancel" : "Check X with Luna"}
          </Text>
        </Pressable>
      </View>
      <Text className="text-xs text-foreground-muted">
        Runs on {label}. Uses Codex allowance. Only checks when you press the button.
      </Text>
      {query._tag === "Failure" || error ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {error ?? "Reset checker unavailable. Reconnect or update this computer's T3 server."}
        </Text>
      ) : null}
      {state?.status === "failed" ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {state.error}
        </Text>
      ) : null}
      {state?.status === "cancelled" ? (
        <Text className="text-sm text-foreground">Check cancelled. No reset time was changed.</Text>
      ) : null}
      {finding ? (
        <View className="gap-2">
          <Text className="text-base font-t3-medium text-foreground">{presentation.title}</Text>
          {presentation.range ? (
            <Text className="text-base text-foreground">{presentation.range}</Text>
          ) : null}
          {presentation.likely && finding.earliestAt !== finding.latestAt ? (
            <Text className="text-sm text-foreground">Most likely: {presentation.likely}</Text>
          ) : null}
          <Text className="text-xs font-t3-medium text-foreground">{presentation.confidence}</Text>
          <Text className="text-sm text-foreground">
            {finding.latestPostsVerified
              ? "Latest X posts verified at check time. "
              : "Latest X feed not verified. "}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Checked {presentation.checked}. Saved result, not a live feed.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            className="min-h-11 justify-center"
            onPress={() => setExpanded(!expanded)}
          >
            <Text className="text-xs text-foreground-muted">
              {expanded ? "Hide sources and reasoning" : "Sources and reasoning"}
            </Text>
          </Pressable>
          {expanded ? (
            <View className="gap-2">
              <Text className="text-sm text-foreground-muted">{finding.summary}</Text>
              <Text className="text-sm text-foreground-muted">{finding.confidenceReason}</Text>
              <Text className="text-sm text-foreground-muted">{finding.accessNote}</Text>
              {finding.sources.map((source, index) => (
                <Pressable
                  key={source.url}
                  accessibilityRole="link"
                  className="min-h-11 justify-center"
                  onPress={() => void Linking.openURL(source.url)}
                >
                  <Text className="text-sm text-foreground">
                    Source {index + 1} · {source.access}
                  </Text>
                </Pressable>
              ))}
              <Text className="text-xs text-foreground-muted">
                Check again for updates. Your account reading confirms an actual reset.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
