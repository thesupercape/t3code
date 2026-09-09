import { useAtomValue } from "@effect/atom-react";
import type { CommunityCheckState, EnvironmentId } from "@t3tools/contracts";
import {
  communityPostLabels,
  latestResetCheck,
  researchCheckDate,
} from "@t3tools/client-runtime/resetCheckPresentation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";

export function CommunityCheckPanel({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const atom = serverEnvironment.communityCheck({ environmentId, input: {} });
  const query = useAtomValue(atom);
  const start = useAtomCommand(serverEnvironment.startCommunityCheck, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelCommunityCheck, { reportFailure: false });
  const [command, setCommand] = useState<CommunityCheckState | null>(null);
  const [sending, setSending] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const state = latestResetCheck(Option.getOrNull(AsyncResult.value(query)), command);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => appAtomRegistry.refresh(atom), 3_000);
    return () => clearInterval(timer);
  }, [atom, running]);
  const act = async () => {
    if (active.current) return;
    active.current = true;
    setSending(true);
    setError(null);
    try {
      const reply = await (running ? cancel : start)({ environmentId, input: {} });
      if (reply._tag === "Success") setCommand(reply.value);
      else setError("Could not reach the community checker. Reconnect and try again.");
      appAtomRegistry.refresh(atom);
    } catch {
      setError("Could not reach the community checker. Reconnect and try again.");
    } finally {
      active.current = false;
      setSending(false);
    }
  };
  const disabled = sending || (!running && (query._tag === "Failure" || state === null));
  const finding = state?.result;
  return (
    <View className="gap-3 border-b border-subtle pb-4">
      <Text className="text-base font-t3-medium text-foreground">What people are saying</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => void act()}
        className="min-h-11 justify-center self-start rounded-md border border-subtle px-3"
      >
        <Text className="text-sm text-foreground">
          {running ? "Cancel community check" : "Check community with Luna"}
        </Text>
      </Pressable>
      <View className="flex-row items-center gap-2">
        {running || sending ? <View className="size-2 rounded-full bg-amber-500" /> : null}
        <Text accessibilityLiveRegion="polite" className="flex-1 text-xs text-foreground-muted">
          {running
            ? "Luna is reading reset discussions on X… You can leave this page."
            : sending
              ? "Contacting Luna…"
              : `Separate from announcements. Runs on ${label} when pressed and uses Codex allowance.`}
        </Text>
      </View>
      {error || query._tag === "Failure" ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {error ?? "Community checker unavailable. Update or reconnect this computer's T3 server."}
        </Text>
      ) : null}
      {state?.status === "failed" ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {state.error}
        </Text>
      ) : null}
      {state?.status === "cancelled" ? (
        <Text className="text-sm text-foreground">Community check cancelled.</Text>
      ) : null}
      {finding ? (
        <View className="gap-3">
          <Text className="text-sm text-foreground">{finding.summary}</Text>
          <Text className="text-xs text-foreground-muted">
            Checked {researchCheckDate(state!.finishedAt)}. Saved snapshot, not a live feed.
          </Text>
          <Text className="text-xs text-foreground-muted">
            {finding.coverage === "live"
              ? "Live X sample read at check time. "
              : "Latest X discussion not fully verified. "}
            {finding.accessNote}
          </Text>
          {finding.posts.map((post) => (
            <View key={post.url} className="gap-1 border-t border-subtle pt-2">
              <Pressable
                accessibilityRole="link"
                className="min-h-11 justify-center"
                onPress={() => void Linking.openURL(post.url)}
              >
                <Text className="text-sm text-foreground">{post.author} ↗</Text>
              </Pressable>
              <Text className="text-xs text-foreground-muted">
                {communityPostLabels[post.kind]}
              </Text>
              <Text className="text-sm text-foreground">{post.summary}</Text>
              <Text className="text-xs text-foreground-muted">
                {researchCheckDate(post.publishedAt)} · {post.access}
              </Text>
            </View>
          ))}
          <Text className="text-xs text-foreground-muted">
            Individual reports are not confirmation of your reset. Your account reading is the
            source for your quota.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
