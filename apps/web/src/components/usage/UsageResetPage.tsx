import { BirthdayGreeting } from "../BirthdayCelebration";
import {
  watchResetAnnouncements,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { refreshCodexMonitor } from "@t3tools/client-runtime/usageRefresh";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  quotaMonitoringSamples,
  quotaCostWindow,
  quotaIntervals,
  quotaPeriods,
  quotaSavedCostPrefix,
  quotaValueSnapshots,
  quotaValueWithHistoricalCalibration,
  quotaValueWithSnapshot,
  retainQuotaValueSnapshots,
  type QuotaValueSnapshot,
} from "@t3tools/shared/usageQuota";

import { isElectron } from "../../env";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

import { TokenBudgetPanel } from "./TokenBudgetPanel";
import { monitoredModels } from "./usageTokenBudget";
import { apiPaceInterval } from "./usageApiPace";
import type { PriorApiPaceInput } from "./usageApiPace";
import { UsagePaceChart } from "./UsagePaceChart";
import { ResetCheckPanel } from "./ResetCheckPanel";
import { CommunityCheckPanel } from "./CommunityCheckPanel";

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const estimate = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

export function UsageResetPage() {
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
  const history = useUsage(historyInput);
  const refreshHistory = useEffectEvent(() => history.refresh());
  useEffect(() => {
    const timer = window.setInterval(refreshHistory, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshHistory();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const [trackerId, setTrackerId] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);
  const trackers = history.environments.filter(
    (environment) =>
      environment.summary?.quotaHistory?.status === "ready" &&
      environment.summary.quotaHistory.samples.length > 0,
  );
  const tracker =
    trackers.find((environment) => environment.environmentId === trackerId) ?? trackers[0];
  const effectiveSelectedIds = useMemo<readonly string[] | null>(
    () => selectedIds ?? (tracker ? [tracker.environmentId] : null),
    [selectedIds, tracker?.environmentId],
  );
  const rawSamples = tracker?.summary?.quotaHistory?.samples;
  const samples = useMemo(() => quotaMonitoringSamples(rawSamples ?? []), [rawSamples]);
  // Keep the complete saved stream for chart/fallback presentation. Cost queries
  // below continue to use only the active monitoring run.
  const historicalPeriods = useMemo(() => quotaPeriods(rawSamples ?? []), [rawSamples]);
  const periods = useMemo(() => quotaPeriods(samples), [samples]);
  const intervals = useMemo(() => quotaIntervals(periods), [periods]);
  const paceInterval = useMemo(() => apiPaceInterval(intervals.at(-1)), [intervals]);
  const costInput = useMemo(
    () => quotaCostWindow(intervals) ?? historyInput,
    [historyInput, intervals],
  );
  const costs = useUsage(costInput);
  const paceInput = useMemo(
    () => (paceInterval ? quotaCostWindow([paceInterval])! : historyInput),
    [paceInterval, historyInput],
  );
  const paceCosts = useUsage(paceInput);
  const historical = historicalPeriods.at(-2);
  const paceModels = useMemo(
    () =>
      paceInterval
        ? monitoredModels(
            paceInterval.id,
            paceCosts.environments.filter(
              (environment) =>
                effectiveSelectedIds === null ||
                effectiveSelectedIds.includes(environment.environmentId),
            ),
          )
        : null,
    [paceInterval, paceCosts.environments, effectiveSelectedIds],
  );
  // A new interval changes the cost query key. While that query is warming,
  // retain the history response for environments that have not answered yet;
  // its saved snapshots keep prior-cycle values visible without treating them
  // as current measured cost. A completed cost response always wins.
  const costEnvironments = useMemo(() => {
    const historyById = new Map(
      history.environments.map((environment) => [environment.environmentId, environment]),
    );
    const current = costs.environments.map((environment) => {
      if (environment.summary !== null || environment.error !== null) return environment;
      return historyById.get(environment.environmentId) ?? environment;
    });
    return current.length > 0 ? current : history.environments;
  }, [costs.environments, history.environments]);
  const selected = useMemo(
    () =>
      costEnvironments.filter(
        (environment) =>
          effectiveSelectedIds === null || effectiveSelectedIds.includes(environment.environmentId),
      ),
    [costEnvironments, effectiveSelectedIds],
  );
  const selectedWithSavedCosts = useMemo(
    () =>
      selected.map((environment) => {
        const historyEnvironment = history.environments.find(
          (candidate) => candidate.environmentId === environment.environmentId,
        );
        const snapshots = historyEnvironment?.summary?.quotaCostSnapshots;
        return snapshots === undefined
          ? environment
          : {
              ...environment,
              summary: environment.summary
                ? {
                    ...environment.summary,
                    quotaCostSnapshots: [
                      ...(environment.summary.quotaCostSnapshots ?? []),
                      ...snapshots,
                    ],
                  }
                : (historyEnvironment?.summary ?? environment.summary),
            };
      }),
    [history.environments, selected],
  );
  const costScope =
    selected.length === 0 ? "No computers selected" : selected.map((e) => e.label).join(", ");
  const currentValues = useMemo(
    () => quotaValueSnapshots(tracker?.environmentId, historicalPeriods, selectedWithSavedCosts),
    [tracker?.environmentId, historicalPeriods, selectedWithSavedCosts],
  );
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, QuotaValueSnapshot>>(
    () => new Map(),
  );
  useEffect(() => {
    setSnapshots((previous) => retainQuotaValueSnapshots(previous, currentValues));
  }, [currentValues]);
  const values = currentValues.map((current, index) => {
    const value = quotaValueWithSnapshot(current, snapshots);
    const previous = index > 0 ? currentValues[index - 1] : undefined;
    return {
      period: current.period,
      value: quotaValueWithHistoricalCalibration(
        { ...current, value },
        previous ? { ...previous, value: quotaValueWithSnapshot(previous, snapshots) } : undefined,
        currentValues.slice(0, index - 1).map((candidate) => ({
          ...candidate,
          value: quotaValueWithSnapshot(candidate, snapshots),
        })),
      ),
    };
  });
  const last = samples.at(-1);
  const current = values.at(-1);
  const calibrationPeriod = useMemo(() => {
    const calibration = current?.value.historicalCalibration;
    if (!calibration) return historical;
    return historicalPeriods.find(
      (period) =>
        period.first.observedAt === calibration.since &&
        period.last.observedAt === calibration.until,
    );
  }, [current?.value.historicalCalibration, historical, historicalPeriods]);
  const calibrationInterval = useMemo(
    () => (calibrationPeriod ? (quotaIntervals([calibrationPeriod]).at(0) ?? null) : null),
    [calibrationPeriod],
  );
  const trackedManualResetCount = tracker?.summary?.quotaHistory?.bankedResetCount;
  const trackedManualResetCheckedAt = tracker?.summary?.quotaHistory?.bankedResetCheckedAt;
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
          refreshCosts: async (input) => {
            const recentInterval = apiPaceInterval(input.quotaIntervals?.at(-1));
            const recentInput = recentInterval ? quotaCostWindow([recentInterval]) : null;
            const replies = await Promise.all([
              costs.refresh(input),
              recentInput ? paceCosts.refresh(recentInput) : Promise.resolve([]),
            ]);
            return replies.flat();
          },
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

  const priorApiPace = useMemo<PriorApiPaceInput | null>(() => {
    if (!calibrationPeriod || !calibrationInterval || !current) return null;
    return {
      interval: calibrationInterval,
      period: calibrationPeriod,
      models: monitoredModels(calibrationInterval, selectedWithSavedCosts),
      remainingValueUsd: current.value.remainingValueUsd,
      ...(current.value.historicalCalibration && calibrationPeriod.id !== historical?.id
        ? { calibrationTargetSince: current.period.first.observedAt }
        : {}),
    };
  }, [calibrationPeriod, calibrationInterval, selectedWithSavedCosts, current, historical]);
  const completed = values.slice(0, -1);
  const currentModels = useMemo(() => {
    if (!current) return null;
    const savedPrefix = quotaSavedCostPrefix(current.period, selectedWithSavedCosts);
    const modelInterval = current.value.costObservedUntil
      ? (savedPrefix?.interval ?? null)
      : {
          id: current.period.id,
          sinceTime: current.period.first.observedAt,
          untilTime: current.period.last.observedAt,
        };
    const modelEnvironments =
      current.value.costObservedUntil && savedPrefix
        ? selectedWithSavedCosts.map((environment) => ({
            ...environment,
            summary: environment.summary
              ? {
                  ...environment.summary,
                  quotaCosts: undefined,
                  quotaCostSnapshots: savedPrefix.rows,
                }
              : environment.summary,
          }))
        : selectedWithSavedCosts;
    if (!modelInterval) return null;
    const models = monitoredModels(modelInterval, modelEnvironments);
    return models !== null &&
      models.length > 0 &&
      models.some((row) => Object.values(row.totals).some((tokens) => tokens > 0))
      ? models
      : null;
  }, [
    current?.period.id,
    current?.period.first.observedAt,
    current?.period.last.observedAt,
    current?.value.costObservedUntil,
    selectedWithSavedCosts,
  ]);
  const models =
    currentModels ??
    (current?.value.historicalCalibration !== undefined ? (priorApiPace?.models ?? null) : null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex w-full min-w-0 items-center gap-3">
          <Link
            to="/usage"
            className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground hover:text-foreground"
          >
            Usage
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <h1 className="truncate text-sm font-medium">Codex monitor</h1>
          <nav
            aria-label="Monitor sections"
            className="ms-4 hidden items-center gap-4 text-xs text-muted-foreground md:flex"
          >
            <a className="hover:text-foreground" href="#api-value">
              API value
            </a>
            <a className="hover:text-foreground" href="#reset-history">
              Reset history
            </a>
            <a className="hover:text-foreground" href="#token-budget">
              Token planner
            </a>
            <a className="hover:text-foreground" href="#luna-research">
              Luna research
            </a>
          </nav>
          <Button
            className="ms-auto size-11"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh Codex usage"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void refreshMonitor()}
          >
            <RefreshCwIcon className={`size-4 ${refreshing ? "motion-safe:animate-spin" : ""}`} />
          </Button>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer
          width="expanded"
          className="pb-[calc(env(safe-area-inset-bottom)+3rem)]"
        >
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {refreshMessage || "Weekly usage, model value and reset research"}
          </p>
          {history.isPending && !last ? <p role="status">Reading Codex usage…</p> : null}
          {history.environments.map((environment) => {
            const saved = environment.summary?.quotaHistory;
            const message =
              environment.error ??
              saved?.message ??
              (environment.summary && saved === undefined
                ? "Update this server to read quota history."
                : null);
            return message ? (
              <p
                key={environment.environmentId}
                role="status"
                className="text-sm text-muted-foreground"
              >
                {environment.label}: {message}
              </p>
            ) : null;
          })}
          {!history.isPending && !last ? (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              No saved quota observations yet. The background collector must be running on a
              connected computer.
            </p>
          ) : null}
          {tracker && last && current ? (
            <>
              <UsagePaceChart
                samples={rawSamples ?? samples}
                news={news}
                manualResets={
                  trackedManualResetCount === undefined
                    ? null
                    : {
                        availableCount: trackedManualResetCount,
                        verified: trackedManualResetCheckedAt !== undefined,
                        ...(trackedManualResetCheckedAt === undefined
                          ? {}
                          : { checkedAt: trackedManualResetCheckedAt }),
                      }
                }
                apiPace={
                  paceInterval
                    ? {
                        interval: paceInterval,
                        models: paceModels,
                        remainingValueUsd: current.value.cachedAt
                          ? null
                          : current.value.remainingValueUsd,
                      }
                    : null
                }
                priorApiPace={priorApiPace}
              />
              <section
                id="api-value"
                className="rounded-xl border border-border bg-card/20 p-5"
                aria-label="Tracked API value"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-medium">API-equivalent value</h2>
                  <span className="text-xs text-muted-foreground">
                    Transcript costs from {costScope} · measured use this cycle
                  </span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-5 [&>div]:min-w-0">
                  <div>
                    <dt className="text-xs text-muted-foreground">Used while monitored</dt>
                    <dd className="mt-1 text-2xl tabular-nums">
                      {current.value.costUsd === null
                        ? "Pending"
                        : formatUsd(current.value.costUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Value of usage remaining</dt>
                    <dd className="mt-1 text-2xl tabular-nums">
                      {current.value.remainingValueUsd === null
                        ? "Learning"
                        : `≈ ${estimate(current.value.remainingValueUsd)}`}
                    </dd>
                  </div>
                </dl>
                {current.value.costObservedUntil ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Observed cost is complete through {dateTime(current.value.costObservedUntil)};
                    newer transcript usage is still being read.
                  </p>
                ) : null}
                {current.value.historicalCalibration ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Remaining value is provisional, calibrated from{" "}
                    {dateTime(current.value.historicalCalibration.since)} to{" "}
                    {dateTime(current.value.historicalCalibration.until)}. Current-cycle calibration
                    replaces it after enough measured usage.
                  </p>
                ) : null}
                {current.period.usedPercentagePoints < 5 &&
                current.value.remainingValueUsd === null ? (
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    {current.period.usedPercentagePoints} of 5 percentage points observed. More
                    readings are needed to estimate dollars left. The {100 - last.remainingPercent}%
                    cycle total includes usage from before monitoring and cannot price this shorter
                    interval.
                  </p>
                ) : current.value.reason ? (
                  <p className="mt-3 text-xs text-muted-foreground">{current.value.reason}</p>
                ) : null}
                {current.value.costUsd === null ? (
                  <p className="mt-2 text-xs text-muted-foreground">{current.value.reason}</p>
                ) : null}
                {current.value.cachedAt ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last complete calculation: {dateTime(current.value.cachedAt)}.
                  </p>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">
                  Token-price estimate, not a bill or cash balance. Codex only.
                </p>
              </section>

              <div id="token-budget">
                <TokenBudgetPanel
                  budgetUsd={current.value.remainingValueUsd}
                  models={models}
                  observedAt={current.period.last.observedAt}
                  provisional={current.value.historicalCalibration !== undefined}
                  {...(current.value.costObservedUntil && !current.value.historicalCalibration
                    ? { currentPrefixThrough: current.value.costObservedUntil }
                    : {})}
                  priorModelMix={
                    currentModels === null && current.value.historicalCalibration !== undefined
                  }
                  {...(current.value.historicalCalibration
                    ? { calibration: current.value.historicalCalibration }
                    : {})}
                />
              </div>
              <BirthdayGreeting />
              <section
                id="reset-history"
                className="border-t border-border pt-5"
                aria-label="Reset history"
              >
                <h2 className="text-sm font-medium">Resets while monitored</h2>
                {historicalPeriods.length < 2 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No reset observed since {dateTime(samples[0]!.observedAt)}. New resets will
                    appear here with the usage left beforehand.
                  </p>
                ) : (
                  <div className="mt-3 divide-y divide-border">
                    {historicalPeriods
                      .slice(0, -1)
                      .toReversed()
                      .map((period) => {
                        const value = values.find((entry) => entry.period.id === period.id)?.value;
                        const unusedLabel =
                          period.usedPercentagePoints === 0 && period.resetKind === "ambiguous"
                            ? "No quota use observed in this interval"
                            : (period.observationGapMs ?? Infinity) > 60 * 60_000 ||
                                value?.unusedValueUsd === null ||
                                value === undefined
                              ? "Dollar estimate not established"
                              : `≈ ${estimate(value.unusedValueUsd)} unused`;
                        return (
                          <div
                            key={period.id}
                            className="flex flex-wrap justify-between gap-3 py-3"
                          >
                            <div>
                              <p className="text-sm">
                                {(period.observationGapMs ?? Infinity) > 60 * 60_000
                                  ? "Window changed across an observation gap"
                                  : period.resetKind === "ambiguous"
                                    ? "Usage window changed"
                                    : "Usage returned"}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {dateTime(period.last.observedAt)} to{" "}
                                {dateTime(period.next!.observedAt)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm tabular-nums">
                                {period.last.remainingPercent}% left · {period.usedPercentagePoints}
                                % used
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {value?.costUsd !== null && value !== undefined
                                  ? `${estimate(value.costUsd)} observed cost${
                                      value.costObservedUntil
                                        ? ` through ${dateTime(value.costObservedUntil)}`
                                        : ""
                                    } · `
                                  : ""}
                                {unusedLabel}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </section>
              <section id="luna-research" aria-label="Reset research" className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-medium">Reset research</h2>
                  <span className="text-xs text-muted-foreground">
                    Luna · public sources · on demand
                  </span>
                </div>
                <div className="grid items-start gap-4 xl:grid-cols-2">
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
                </div>
              </section>
              <details className="border-t border-border">
                <summary className="min-h-11 cursor-pointer content-center text-sm">
                  Tracking and computers
                </summary>
                <div className="space-y-4 pt-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Monitoring since {dateTime(samples[0]!.observedAt)}. {samples.length} readings.
                    Readings update every minute; the collector records every five minutes while the
                    computer is awake and signed in. Older history stays saved but is excluded after
                    a day-long monitoring gap.
                  </p>
                  <label className="flex flex-col gap-2 text-sm">
                    Quota source
                    <select
                      className="min-h-11 w-full rounded-md border border-border bg-background p-2 text-base"
                      value={tracker.environmentId}
                      onChange={(e) => setTrackerId(e.target.value)}
                    >
                      {trackers.map((environment) => (
                        <option key={environment.environmentId} value={environment.environmentId}>
                          {environment.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend className="text-sm">Computers included in dollar estimates</legend>
                    {costs.environments.map((environment) => (
                      <label
                        key={environment.environmentId}
                        className="flex min-h-11 items-center gap-3 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="size-5 shrink-0"
                          checked={
                            effectiveSelectedIds === null ||
                            effectiveSelectedIds.includes(environment.environmentId)
                          }
                          onChange={(event) => {
                            const ids = new Set(
                              effectiveSelectedIds ??
                                costs.environments.map((entry) => entry.environmentId),
                            );
                            if (event.target.checked) ids.add(environment.environmentId);
                            else ids.delete(environment.environmentId);
                            setSelectedIds([...ids]);
                          }}
                        />
                        <span className="break-words">{environment.label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="text-xs text-muted-foreground">
                    Choose computers using the same Codex account. Quota percentages are never added
                    across machines. Account identity and copied chats cannot be verified here.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Public reset news is checked every five minutes while this page is open. Only
                    the news service receives that request, without your usage, chat data or account
                    credentials.
                  </p>
                </div>
              </details>
            </>
          ) : null}
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}
