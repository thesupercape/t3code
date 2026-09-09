import {
  watchResetAnnouncements,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { refreshCodexMonitor } from "@t3tools/client-runtime/usageRefresh";
import { AppState, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  quotaMonitoringSamples,
  quotaCostWindow,
  quotaIntervals,
  quotaPeriods,
  quotaValueSnapshots,
  quotaValueWithSnapshot,
  retainQuotaValueSnapshots,
  type QuotaValueSnapshot,
} from "@t3tools/shared/usageQuota";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage } from "../../state/usage";

import { UsagePaceChart } from "./UsagePaceChart";
import { ResetCheckPanel } from "./ResetCheckPanel";
import { CommunityCheckPanel } from "./CommunityCheckPanel";

export function UsageResetScreen({ onBack }: { readonly onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [historyInput] = useState(() => ({ ...makeWindow(1), quotaHistoryOnly: true }));
  const [news, setNews] = useState<ResetNews>({
    announcement: null,
    checkedAt: null,
    status: "loading",
  });
  const newsWatcher = useRef<ReturnType<typeof watchResetAnnouncements> | null>(null);
  useEffect(() => {
    const watcher = watchResetAnnouncements(setNews);
    newsWatcher.current = watcher;
    return () => {
      watcher.stop();
      newsWatcher.current = null;
    };
  }, []);
  const refreshActive = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [showTracking, setShowTracking] = useState(false);
  const history = useUsage(historyInput);
  const refreshHistory = useEffectEvent(() => history.refresh());
  useEffect(() => {
    const timer = setInterval(refreshHistory, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshHistory();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  const [trackerId, setTrackerId] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);
  const trackers = history.environments.filter(
    (entry) =>
      entry.summary?.quotaHistory?.status === "ready" &&
      entry.summary.quotaHistory.samples.length > 0,
  );
  const tracker = trackers.find((entry) => entry.environmentId === trackerId) ?? trackers[0];
  const rawSamples = tracker?.summary?.quotaHistory?.samples;
  const samples = useMemo(() => quotaMonitoringSamples(rawSamples ?? []), [rawSamples]);
  const periods = useMemo(() => quotaPeriods(samples), [samples]);
  const intervals = useMemo(() => quotaIntervals(periods), [periods]);
  const input = useMemo(
    () => quotaCostWindow(intervals) ?? historyInput,
    [historyInput, intervals],
  );
  const costs = useUsage(input);
  const selected = useMemo(
    () =>
      costs.environments.filter(
        (entry) => selectedIds === null || selectedIds.includes(entry.environmentId),
      ),
    [costs.environments, selectedIds],
  );
  const currentValues = useMemo(
    () => quotaValueSnapshots(tracker?.environmentId, periods, selected),
    [tracker?.environmentId, periods, selected],
  );
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, QuotaValueSnapshot>>(
    () => new Map(),
  );
  useEffect(() => {
    setSnapshots((previous) => retainQuotaValueSnapshots(previous, currentValues));
  }, [currentValues]);
  const values = currentValues.map((current) => ({
    period: current.period,
    value: quotaValueWithSnapshot(current, snapshots),
  }));
  const last = samples.at(-1);
  const refreshMonitor = async () => {
    if (refreshActive.current) return;
    refreshActive.current = true;
    setRefreshing(true);
    setRefreshMessage("Refreshing readings, API costs and reset news…");
    try {
      setRefreshMessage(
        await refreshCodexMonitor({
          trackerId: tracker?.environmentId,
          refreshHistory: history.refresh,
          refreshCosts: costs.refresh,
          refreshNews: () => newsWatcher.current?.refresh() ?? Promise.resolve(false),
          onProgress: setRefreshMessage,
        }),
      );
    } catch {
      setRefreshMessage("Refresh did not finish. Check your connection and try again.");
    } finally {
      refreshActive.current = false;
      setRefreshing(false);
    }
  };

  const current = values.at(-1);
  const completed = values.slice(0, -1);
  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: "Codex monitor" }} />
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refreshMonitor()} />
        }
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="flex-row justify-between gap-2">
          <Pressable
            className="min-h-11 justify-center"
            accessibilityRole="button"
            onPress={onBack}
          >
            <Text className="text-sm text-foreground">Back to usage</Text>
          </Pressable>
          <Pressable
            className="min-h-11 justify-center"
            accessibilityRole="button"
            accessibilityLabel="Refresh Codex usage"
            accessibilityState={{ busy: refreshing, disabled: refreshing }}
            disabled={refreshing}
            onPress={() => void refreshMonitor()}
          >
            <Text className="text-sm text-foreground">
              {refreshing ? "Refreshing…" : "Refresh"}
            </Text>
          </Pressable>
        </View>
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {refreshMessage || "Refresh checks saved readings, API costs and reset news."}
        </Text>
        {history.isPending && !last ? (
          <Text className="text-sm text-foreground-muted">Reading Codex usage…</Text>
        ) : null}
        {history.environments.map((entry) => {
          const saved = entry.summary?.quotaHistory;
          const message =
            entry.error ??
            saved?.message ??
            (entry.summary && saved === undefined
              ? "Update this server to read quota history."
              : null);
          return message ? (
            <Text key={entry.environmentId} className="text-sm text-foreground-muted">
              {entry.label}: {message}
            </Text>
          ) : null;
        })}
        {!history.isPending && !last ? (
          <Text className="text-sm text-foreground-muted">
            No saved quota observations yet. Start the background collector on a connected computer.
          </Text>
        ) : null}
        {current && last ? (
          <>
            <UsagePaceChart
              samples={samples}
              news={news}
              resetCheck={
                <>
                  <ResetCheckPanel
                    key={tracker.environmentId}
                    environmentId={tracker.environmentId}
                    label={tracker.label}
                  />
                  <CommunityCheckPanel
                    key={`community-${tracker.environmentId}`}
                    environmentId={tracker.environmentId}
                    label={tracker.label}
                  />
                </>
              }
            />
            <View className="gap-3 border-t border-subtle pt-5">
              <Text className="text-base font-t3-medium text-foreground">API-equivalent value</Text>
              <View className="flex-row gap-5">
                <View className="flex-1 gap-1">
                  <Text className="text-xs text-foreground-muted">Used while monitored</Text>
                  <Text className="text-2xl text-foreground">
                    {current.value.costUsd === null ? "Pending" : formatUsd(current.value.costUsd)}
                  </Text>
                </View>
                <View className="flex-1 gap-1">
                  <Text className="text-xs text-foreground-muted">Value of usage remaining</Text>
                  <Text className="text-2xl text-foreground">
                    {current.value.remainingValueUsd === null
                      ? "Learning"
                      : `≈ ${formatUsd(current.value.remainingValueUsd)}`}
                  </Text>
                </View>
              </View>
              {current.period.usedPercentagePoints < 5 ? (
                <Text className="text-xs text-foreground-muted">
                  {current.period.usedPercentagePoints} of 5 percentage points observed. The{" "}
                  {100 - last.remainingPercent}% cycle total includes usage before monitoring and
                  cannot price this shorter interval.
                </Text>
              ) : null}
              {current.value.costUsd === null || current.period.usedPercentagePoints >= 5 ? (
                <Text className="text-xs text-foreground-muted">{current.value.reason}</Text>
              ) : null}
              {current.value.cachedAt ? (
                <Text className="text-xs text-foreground-muted">
                  Last complete calculation: {new Date(current.value.cachedAt).toLocaleString()}.
                </Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">
                Token-price estimate, not a bill or cash balance. Codex only.
              </Text>
            </View>
            <View className="gap-3 border-t border-subtle pt-5">
              <Text className="text-base font-t3-medium text-foreground">
                Resets while monitored
              </Text>
              {completed.length === 0 ? (
                <Text className="text-sm text-foreground-muted">
                  No reset observed since {new Date(samples[0]!.observedAt).toLocaleString()}. New
                  resets will appear here with the usage left beforehand.
                </Text>
              ) : (
                completed.toReversed().map(({ period, value }) => (
                  <View key={period.id} className="gap-1">
                    <Text className="text-sm text-foreground">
                      {period.resetKind === "ambiguous" ? "Usage window changed" : "Usage returned"}{" "}
                      · {period.last.remainingPercent}% left beforehand
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {new Date(period.last.observedAt).toLocaleString()} to{" "}
                      {new Date(period.next!.observedAt).toLocaleString()}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {value.unusedValueUsd === null
                        ? "Dollar estimate not established"
                        : `≈ ${formatUsd(value.unusedValueUsd)} unused`}
                    </Text>
                  </View>
                ))
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showTracking }}
              className="min-h-11 justify-center border-t border-subtle"
              onPress={() => setShowTracking(!showTracking)}
            >
              <Text className="text-sm text-foreground">
                Tracking and computers {showTracking ? "−" : "+"}
              </Text>
            </Pressable>
            {showTracking ? (
              <View className="gap-3">
                <Text className="text-xs text-foreground-muted">
                  Monitoring since {new Date(samples[0]!.observedAt).toLocaleString()}.{" "}
                  {samples.length} readings. Older history stays saved but is excluded after a
                  day-long monitoring gap.
                </Text>
                <Text className="text-xs text-foreground-muted">
                  The collector records every five minutes while the computer is awake and signed
                  in. Public reset news is checked every five minutes while this page is open,
                  without sending account or usage data.
                </Text>
                <Text className="text-sm text-foreground">Quota source</Text>
                {trackers.map((entry) => (
                  <Pressable
                    key={entry.environmentId}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: entry === tracker }}
                    className="min-h-11 justify-center"
                    onPress={() => setTrackerId(entry.environmentId)}
                  >
                    <Text className="text-sm text-foreground">
                      {entry === tracker ? "Selected: " : ""}
                      {entry.label}
                    </Text>
                  </Pressable>
                ))}
                <Text className="text-sm text-foreground">Computers in dollar estimates</Text>
                {costs.environments.map((entry) => (
                  <View
                    key={entry.environmentId}
                    className="flex-row items-center justify-between gap-3"
                  >
                    <Text className="flex-1 text-sm text-foreground">{entry.label}</Text>
                    <Switch
                      accessibilityLabel={`Include ${entry.label}`}
                      value={selectedIds === null || selectedIds.includes(entry.environmentId)}
                      onValueChange={(checked) => {
                        const ids = selectedIds ?? costs.environments.map((e) => e.environmentId);
                        setSelectedIds(
                          checked
                            ? [...ids, entry.environmentId]
                            : ids.filter((id) => id !== entry.environmentId),
                        );
                      }}
                    />
                  </View>
                ))}
                <Text className="text-xs text-foreground-muted">
                  Choose computers using the same Codex account. Percentages are never added across
                  machines. Account identity and copied chats cannot be verified here.
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
