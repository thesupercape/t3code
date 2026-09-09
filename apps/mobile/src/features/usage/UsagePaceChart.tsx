import type { UsageQuotaSample } from "@t3tools/contracts";
import {
  currentResetAnnouncement,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import {
  describeRecentQuotaPace,
  quotaDuration,
  quotaForecast,
} from "@t3tools/shared/usageQuotaForecast";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, Switch, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { AppText as Text } from "../../components/AppText";
import { useProviderColors } from "./usageProviders";

export function UsagePaceChart({
  samples,
  news,
  resetCheck,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly news?: ResetNews;
  readonly resetCheck?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(1);
  const [recorded, setRecorded] = useState(false);
  const [showRecentPace, setShowRecentPace] = useState(true);
  const colors = useProviderColors();
  useEffect(() => setNow(Date.now()), [samples]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const announced = currentResetAnnouncement(news, samples.at(-1), now);
  const forecast = useMemo(
    () => quotaForecast(samples, now, 3, announced?.targetAt),
    [samples, now, announced],
  );
  if (!forecast) return null;
  const f = forecast;
  const date = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const y = (percent: number) => 196 - percent * 1.92;
  const pointX = (p: (typeof f.points)[number]) =>
    recorded
      ? (Date.parse(p.observedAt) - Date.parse(f.first.observedAt)) /
        Math.max(Date.parse(f.latest.observedAt) - Date.parse(f.first.observedAt), 1)
      : p.x;
  const path = f.points
    .map((p) => `${p.breakBefore ? "M" : "L"}${pointX(p) * width},${y(p.remainingPercent)}`)
    .join(" ");
  return (
    <View className="gap-3 border-y border-subtle py-5">
      <Text className="text-sm text-foreground-muted">Current weekly limit</Text>
      <View className="flex-row items-end justify-between gap-3">
        <View>
          <Text className="text-6xl text-foreground">{f.latest.remainingPercent}%</Text>
          <Text className="text-sm text-foreground-muted">remaining</Text>
        </View>
        <View>
          <Text className="text-3xl text-foreground">{f.usedPercent}%</Text>
          <Text className="text-sm text-foreground-muted">used this cycle</Text>
        </View>
      </View>
      <Text className="text-xs text-foreground-muted">
        The monitor captured a {f.monitoredUsedPercent}-point drop since {date(f.first.observedAt)}.
        You had already used {f.usedBeforeMonitoring}% when it started.
      </Text>
      <Text className="text-xs text-foreground-muted">Updated {date(f.latest.observedAt)}.</Text>
      {f.stale ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          Tracker needs attention. No fresh weekly reading. This forecast is historical, not
          current.
        </Text>
      ) : null}
      {f.historicalPace ? (
        <Text className="border-l-2 border-sky-500 pl-3 text-sm text-foreground">
          Provisional pace uses the completed cycle from {date(f.historicalPace.since)} through{" "}
          {date(f.historicalPace.until)} while this cycle warms. Fresh current-cycle readings
          replace it automatically.
        </Text>
      ) : null}
      <View className="gap-1 border-y border-subtle py-4">
        <Text className="text-base font-t3-medium text-foreground">
          {f.usesAnnouncement ? "Announced reset" : "Weekly reset"} · {quotaDuration(f.resetInMs)}{" "}
          left
        </Text>
        <Text className="text-sm text-foreground">{date(f.planningResetAt)}</Text>
        {announced ? (
          <>
            <Text className="text-xs text-foreground-muted">
              {f.usesAnnouncement
                ? "Planning uses the earlier announcement."
                : "Announced time passed. Waiting for account confirmation."}{" "}
              Weekly timer: {date(f.latest.resetsAt)}.
            </Text>
            <Pressable
              accessibilityRole="link"
              className="min-h-11 justify-center"
              onPress={() => void Linking.openURL(announced.sourceUrl)}
            >
              <Text className="text-sm text-foreground">Tibo's post, via Reset Beacon ↗</Text>
            </Pressable>
          </>
        ) : (
          <Text className="text-xs text-foreground-muted">
            {news?.status === "unavailable"
              ? "Reset news unavailable. Using the weekly timer."
              : "No earlier announcement available."}
          </Text>
        )}
      </View>
      {resetCheck}
      <Text className="text-base font-t3-medium text-foreground">Usage to next reset</Text>
      <View className="flex-row gap-3">
        {[true, false].map((value) => (
          <Pressable
            key={String(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: recorded === value }}
            className="min-h-11 justify-center px-3"
            onPress={() => setRecorded(value)}
          >
            <Text className="text-sm text-foreground">
              {value ? "Recorded" : "To reset"}
              {recorded === value ? " ✓" : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      <View className="flex-row gap-2">
        <View className="h-[200px] w-10 justify-between">
          {[100, 50, 0].map((tick) => (
            <Text key={tick} className="text-xs text-foreground-muted">
              {tick}%
            </Text>
          ))}
        </View>
        <View
          className="flex-1"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          accessibilityRole="image"
          accessibilityLabel="Weekly remaining usage, target pace and projected exhaustion"
        >
          <Svg width={width} height={200}>
            {[4, 100, 196].map((lineY) => (
              <Line
                key={lineY}
                x1={0}
                x2={width}
                y1={lineY}
                y2={lineY}
                stroke={colors.codex}
                strokeOpacity={0.2}
              />
            ))}
            {!recorded ? (
              <Line
                x1={f.observationX * width}
                y1={y(f.latest.remainingPercent)}
                x2={width}
                y2={y(f.reserve)}
                stroke={colors.codex}
                strokeOpacity={0.5}
                strokeDasharray="6 5"
                strokeWidth={2}
              />
            ) : null}
            <Path d={path} fill="none" stroke={colors.codex} strokeWidth={2.5} />
            <Circle
              cx={(recorded ? (f.points.length > 1 ? 1 : 0) : f.observationX) * width}
              cy={y(f.latest.remainingPercent)}
              r={3}
              fill={colors.codex}
            />
            {!recorded ? (
              <Line
                x1={f.observationX * width}
                y1={y(f.latest.remainingPercent)}
                x2={f.projectionEndX * width}
                y2={y(f.projectionEndPercent)}
                stroke="#d88d42"
                strokeWidth={2.5}
                strokeDasharray="7 4"
              />
            ) : null}
            {!recorded && f.exhaustsBeforeReset ? (
              <Line
                x1={f.projectionEndX * width}
                x2={f.projectionEndX * width}
                y1={4}
                y2={196}
                stroke="#d88d42"
                strokeDasharray="2 5"
              />
            ) : null}
            {!recorded && showRecentPace && f.recentPace ? (
              <Path
                accessibilityLabel="Recent pace projection"
                d={`M${f.observationX * width},${y(f.latest.remainingPercent)} L${f.recentPace.projectionEndX * width},${y(f.recentPace.projectionEndPercent)} L${width},${y(f.recentPace.projectionEndPercent)}`}
                fill="none"
                stroke="#52b8bf"
                strokeWidth={2.5}
                strokeDasharray="3 3"
              />
            ) : null}
          </Svg>
        </View>
      </View>
      <View className="flex-row justify-between gap-3">
        <Text className="text-xs text-foreground-muted">
          {new Date(f.startsAt).toLocaleDateString()}
        </Text>
        <Text className="flex-1 text-right text-xs text-foreground-muted">
          {recorded ? date(f.latest.observedAt) : `Reset ${date(f.planningResetAt)}`}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        {recorded
          ? "Saved account readings"
          : `Solid: recorded · Dashed: target, ${f.reserve}% reserve · Orange: blended pace`}
      </Text>
      {!recorded ? (
        <View className="gap-1">
          <View className="min-h-11 flex-row items-center justify-between gap-3">
            <Text className="text-sm" style={{ color: "#52b8bf" }}>
              ┄ Recent pace
            </Text>
            <Switch
              accessibilityLabel="Show recent pace"
              value={showRecentPace}
              onValueChange={setShowRecentPace}
            />
          </View>
          {showRecentPace ? (
            <Text className="text-xs text-foreground-muted">{describeRecentQuotaPace(f)}</Text>
          ) : null}
        </View>
      ) : null}
      <Text className="text-sm text-foreground">
        {f.stale ? "Last projected exhaustion" : "Projected exhaustion"}:{" "}
        {f.exhaustionAt ? date(f.exhaustionAt) : "No burn observed"}
      </Text>
      {!f.stale && f.exhaustionInMs !== null ? (
        <Text className="text-sm text-foreground-muted">
          {quotaDuration(f.exhaustionInMs)} at this pace.{" "}
          {f.exhaustsBeforeReset ? "Before the next reset." : "Reset comes first."}
        </Text>
      ) : null}
      <Text className="text-sm text-foreground">
        {f.remainingAtReset.toFixed(0)}% projected left at reset.
      </Text>
      <Text className="text-sm text-foreground">
        {f.historicalPace ? "Provisional blended burn" : "Blended burn"}:{" "}
        {(f.expectedPercentPerDay / 24).toFixed(2)}% / hour.
      </Text>
      <Text className="text-sm text-foreground">
        Pace to reset:{" "}
        {(f.resetInMs < 86_400_000
          ? f.recommendedPercentPerDay / 24
          : f.recommendedPercentPerDay
        ).toFixed(1)}
        % / {f.resetInMs < 86_400_000 ? "hour" : "day"} to leave {f.reserve}% at reset.
      </Text>
      <Text className="text-xs text-foreground-muted">
        Orange blends monitored usage with the weekly average. Recent pace uses the last observed 1%
        interval, slowing down when fresh readings show the next drop is taking longer. Percentages
        are rounded and checked periodically, so drop times are approximate.
      </Text>
    </View>
  );
}
