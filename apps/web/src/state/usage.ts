/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { usageQueryInput } from "@t3tools/client-runtime/usageRefresh";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const MAX_STALLED_DEFERRED_REFRESHES = 5;
const DEFERRED_TRANSCRIPT_REFRESH_BASE_MS = 750;
const DEFERRED_TRANSCRIPT_REFRESH_MAX_MS = 8_000;

const isDeferredTranscriptSource = (
  source: NonNullable<EnvironmentUsageStatus["summary"]>["sources"][number],
) => source.status === "partial" && /\bdeferred\b/i.test(source.message ?? "");

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<readonly EnvironmentUsageStatus[]>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  const windowKey = useMemo(
    () => JSON.stringify(usageQueryInput(input, USAGE_CONTRACT_VERSION)),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      input.includeQuotaHistory,
      input.quotaHistoryOnly,
      input.quotaIntervals,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const observedEnvironments = useAtomValue(atom);
  const selectedObservedEnvironments =
    selectedEnvironmentIds === null
      ? observedEnvironments
      : observedEnvironments.filter((environment) =>
          selectedEnvironmentIds.has(environment.environmentId),
        );
  const [refreshed, setRefreshed] = useState<{
    readonly windowKey: string;
    readonly generation: number;
    readonly statuses: readonly EnvironmentUsageStatus[];
    readonly baselineReadAt: ReadonlyMap<string, string | undefined>;
  } | null>(null);
  const environments = useMemo(() => {
    if (refreshed?.windowKey !== windowKey) return selectedObservedEnvironments;
    const byId = new Map(refreshed.statuses.map((status) => [status.environmentId, status]));
    return selectedObservedEnvironments.map((environment) => {
      const refreshedEnvironment = byId.get(environment.environmentId);
      if (refreshedEnvironment === undefined) return environment;
      const observedAt = environment.summary?.readAt;
      const refreshedAt = refreshedEnvironment.summary?.readAt;
      const baselineAt = refreshed.baselineReadAt.get(environment.environmentId);
      // Imperative refreshes are kept locally because the shared atom can
      // finish on a later turn. Once that atom has a newer server reading,
      // let it win so a refresh cannot pin the page to an older answer.
      if (
        observedAt !== undefined &&
        ((refreshedAt !== undefined && observedAt > refreshedAt) ||
          (refreshedAt === undefined && observedAt !== baselineAt))
      ) {
        return environment;
      }
      return refreshedEnvironment;
    });
  }, [selectedObservedEnvironments, refreshed, windowKey]);
  const retriedFailures = useRef(new Set<string>());
  const delayedRetries = useRef(new Set<string>());
  const delayedRetryTimers = useRef(new Map<string, number>());
  const deferredTranscriptRetry = useRef({
    windowKey,
    signature: "",
    stalledAttempts: 0,
    timer: null as number | null,
  });
  const refreshInFlight = useRef<{
    readonly requestWindowKey: string;
    readonly promise: Promise<readonly EnvironmentUsageStatus[]>;
  } | null>(null);
  const refreshGeneration = useRef(0);
  const windowKeyRef = useRef(windowKey);
  windowKeyRef.current = windowKey;

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(
    async (nextInput?: UsageSummaryInput) => {
      const input = nextInput
        ? usageQueryInput(nextInput, USAGE_CONTRACT_VERSION)
        : (JSON.parse(windowKey) as UsageSummaryInput);
      const requestWindowKey = JSON.stringify(input);
      const inFlight = refreshInFlight.current;
      if (inFlight?.requestWindowKey === requestWindowKey) {
        return inFlight.promise;
      }
      const requestInput = { ...input, refresh: nextInput?.refresh ?? true };
      const generation = refreshGeneration.current + 1;
      refreshGeneration.current = generation;
      const baselineReadAt = new Map(
        environments.map((environment) => [environment.environmentId, environment.summary?.readAt]),
      );
      const requestStatuses = environments.map((environment) =>
        requestWindowKey === windowKey
          ? { ...environment, isPending: true }
          : { ...environment, isPending: true, error: null, summary: null },
      );
      setRefreshed({
        windowKey: requestWindowKey,
        generation,
        statuses: requestStatuses,
        baselineReadAt,
      });
      const promise = (async () => {
        const statuses = await Promise.all(
          environments.map(async (environment) => {
            const result = await executeAtomQuery(
              appAtomRegistry,
              serverEnvironment.usageSummary({
                environmentId: environment.environmentId,
                input: requestInput,
              }),
              { refresh: true, reportFailure: false, reportDefect: false },
            );
            const status = {
              ...environment,
              isPending: false,
              error: result._tag === "Failure" ? "This environment could not report usage." : null,
              summary:
                result._tag === "Failure" && requestWindowKey === windowKey
                  ? environment.summary
                  : Option.getOrNull(AsyncResult.value(result)),
            };
            setRefreshed((previous) => {
              if (previous?.generation !== generation) return previous;
              const nextStatuses = previous.statuses.map((entry) =>
                entry.environmentId === status.environmentId ? status : entry,
              );
              return { ...previous, statuses: nextStatuses };
            });
            return status;
          }),
        );
        setRefreshed((previous) =>
          previous?.generation === generation
            ? { ...previous, windowKey: requestWindowKey, statuses }
            : previous,
        );
        return statuses;
      })();
      refreshInFlight.current = { requestWindowKey, promise };
      const settleInFlight = (statuses?: readonly EnvironmentUsageStatus[]) => {
        if (refreshInFlight.current?.promise === promise) refreshInFlight.current = null;
        if (
          statuses?.some((status) => status.error !== null) === true &&
          windowKeyRef.current === requestWindowKey
        ) {
          const pendingRetryKeys = [...delayedRetries.current].filter((retryKey) =>
            retryKey.startsWith(`${requestWindowKey}:`),
          );
          for (const retryKey of pendingRetryKeys) delayedRetries.current.delete(retryKey);
          if (pendingRetryKeys.length > 0) void refreshRef.current();
        }
      };
      void promise.then(settleInFlight, () => settleInFlight());
      return promise;
    },
    [environments, windowKey],
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Route navigation can remount this view while its shared atom still holds a
  // transient disconnected result. Retry that result once on entry so mobile
  // users do not need to reload the whole browser tab.
  useEffect(() => {
    const failedIds = environments
      .filter((environment) => environment.error !== null && !environment.isPending)
      .map((environment) => environment.environmentId)
      .sort();
    if (failedIds.length === 0) {
      // A refresh keeps a prior error on its pending overlay so the delayed
      // reconnect retry survives until the request settles. Do not clear its
      // budget or timer merely because that overlay is pending.
      if (environments.some((environment) => environment.error !== null)) return;
      // A successful reading closes the previous reconnect episode; a later
      // disconnect must be eligible for its own recovery retry.
      retriedFailures.current.clear();
      delayedRetries.current.clear();
      for (const timer of delayedRetryTimers.current.values()) window.clearTimeout(timer);
      delayedRetryTimers.current.clear();
      return;
    }
    const retryKey = `${windowKey}:${failedIds.join(",")}`;
    if (delayedRetries.current.has(retryKey)) {
      if (refreshInFlight.current?.requestWindowKey === windowKey) return;
      // The delayed retry elapsed while the first recovery request was still
      // active. Consume it once after that request settles, without resetting
      // the episode budget and allowing an unbounded retry loop.
      delayedRetries.current.delete(retryKey);
      void refreshRef.current();
      return;
    }
    if (retriedFailures.current.has(retryKey)) return;
    retriedFailures.current.add(retryKey);
    void refreshRef.current();
    // A first read can be interrupted while a remote WebSocket is reconnecting.
    // Keep one delayed retry alive across the transient pending/error renders.
    const timer = window.setTimeout(() => {
      delayedRetryTimers.current.delete(retryKey);
      if (windowKeyRef.current !== windowKey) return;
      if (refreshInFlight.current?.requestWindowKey === windowKey) {
        // The first recovery request is still active. Let its settled result
        // drive this effect so a slow scan cannot be duplicated. The marker
        // is consumed by that settled result exactly once.
        delayedRetries.current.add(retryKey);
        return;
      }
      void refreshRef.current();
    }, 3_000);
    delayedRetryTimers.current.set(retryKey, timer);
  }, [environments, refresh, windowKey]);

  useEffect(() => {
    const timers = delayedRetryTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      delayedRetries.current.clear();
      const deferred = deferredTranscriptRetry.current;
      if (deferred.timer !== null) window.clearTimeout(deferred.timer);
      deferred.timer = null;
    };
  }, [windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments]);

  const hasDeferredTranscripts = environments.some((environment) =>
    environment.summary?.sources.some(isDeferredTranscriptSource),
  );

  // A bounded server scan intentionally returns partial data while its cache is
  // cold. Keep advancing that cache while the Usage page is mounted so totals
  // converge without asking the user to click Refresh once per 128 MiB batch.
  useEffect(() => {
    const retry = deferredTranscriptRetry.current;
    if (retry.windowKey !== windowKey) {
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retry.windowKey = windowKey;
      retry.signature = "";
      retry.stalledAttempts = 0;
      retry.timer = null;
    }
    if (!hasDeferredTranscripts) {
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retry.signature = "";
      retry.stalledAttempts = 0;
      retry.timer = null;
      return;
    }
    const deferredSignature = environments
      .flatMap((environment) =>
        (environment.summary?.sources ?? [])
          .filter(isDeferredTranscriptSource)
          .map(
            (source) =>
              `${environment.environmentId}:${source.fingerprint.resolvedHomePath}:${source.scannedFiles}:${source.skippedFiles}:${source.message ?? ""}`,
          ),
      )
      .sort()
      .join("|");
    if (retry.signature !== deferredSignature) {
      retry.signature = deferredSignature;
      retry.stalledAttempts = 0;
    }
    const waitingOrFailed = environments.some(
      (environment) => environment.isPending || environment.error !== null,
    );
    if (waitingOrFailed) {
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retry.timer = null;
      return;
    }
    if (retry.stalledAttempts >= MAX_STALLED_DEFERRED_REFRESHES || retry.timer !== null) {
      return;
    }
    const delay = Math.min(
      DEFERRED_TRANSCRIPT_REFRESH_MAX_MS,
      DEFERRED_TRANSCRIPT_REFRESH_BASE_MS * 2 ** Math.min(retry.stalledAttempts, 4),
    );
    retry.timer = window.setTimeout(() => {
      retry.timer = null;
      if (windowKeyRef.current !== windowKey) return;
      retry.stalledAttempts += 1;
      void refresh({
        ...(JSON.parse(windowKey) as UsageSummaryInput),
        refresh: false,
      });
    }, delay);
  }, [environments, hasDeferredTranscripts, refresh, windowKey]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments: environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
