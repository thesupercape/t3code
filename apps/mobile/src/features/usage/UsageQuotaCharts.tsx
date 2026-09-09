import type { UsageQuotaSample } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { quotaHistoryPoints, type QuotaPeriod, type QuotaValue } from "@t3tools/shared/usageQuota";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { AppText as Text } from "../../components/AppText";
import { useProviderColors } from "./usageProviders";

export function UsageQuotaCharts({
  samples,
  values,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly values: readonly { period: QuotaPeriod; value: QuotaValue }[];
}) {
  const points = useMemo(() => quotaHistoryPoints(samples), [samples]);
  const [index, setIndex] = useState<number | null>(null);
  const [width, setWidth] = useState(1);
  const colors = useProviderColors();
  const selectedIndex = Math.min(index ?? points.length - 1, points.length - 1);
  const selected = points[selectedIndex];
  const peak = Math.max(
    1,
    ...values.flatMap(({ value }) => [value.costUsd ?? 0, value.remainingValueUsd ?? 0]),
  );
  const path = points
    .map(
      (p) =>
        `${p.breakBefore ? "M" : "L"}${p.x * width},${4 + (100 - p.remainingPercent) * 1.92}${p.breakBefore ? "l0,0" : ""}`,
    )
    .join(" ");
  const day = (at: string) =>
    new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!selected) return null;
  return (
    <View className="gap-5">
      <Text className="text-base font-t3-medium text-foreground">
        Codex usage remaining over time
      </Text>
      <Text className="text-xs text-foreground-muted">
        Saved weekly quota, 0–100%. Gaps over an hour and reset changes are not joined. Tap the
        chart to inspect a reading.
      </Text>
      <View className="flex-row gap-2">
        <View className="h-[200px] w-10 justify-between">
          {[100, 50, 0].map((tick) => (
            <Text key={tick} className="text-xs text-foreground-muted">
              {tick}%
            </Text>
          ))}
        </View>
        <Pressable
          className="flex-1"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          accessibilityRole="image"
          accessibilityLabel="Recorded Codex quota remaining over time"
          onPress={(event) => {
            const x = event.nativeEvent.locationX / width;
            let nearest = selectedIndex;
            points.forEach((p, i) => {
              if (Math.abs(p.x - x) < Math.abs(points[nearest]!.x - x)) nearest = i;
            });
            setIndex(nearest);
          }}
        >
          <Svg width={width} height={200}>
            {[4, 100, 196].map((y) => (
              <Line
                key={y}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke={colors.codex}
                strokeOpacity={0.2}
              />
            ))}
            {points
              .filter((p) => p.resetChange)
              .map((p) => (
                <Line
                  key={p.observedAt}
                  x1={p.x * width}
                  x2={p.x * width}
                  y1={4}
                  y2={196}
                  stroke={colors.codex}
                  strokeDasharray="3 4"
                  strokeOpacity={0.5}
                />
              ))}
            <Path
              d={path}
              fill="none"
              stroke={colors.codex}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <Line
              x1={selected.x * width}
              x2={selected.x * width}
              y1={4}
              y2={196}
              stroke={colors.codex}
              strokeOpacity={0.5}
            />
          </Svg>
        </Pressable>
      </View>
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground-muted">{day(points[0]!.observedAt)}</Text>
        <Text className="text-xs text-foreground-muted">{day(points.at(-1)!.observedAt)}</Text>
      </View>
      <Text className="text-sm text-foreground" accessibilityLiveRegion="polite">
        {new Date(selected.observedAt).toLocaleString()} · {selected.remainingPercent}% remaining
        {selected.resetChange ? " · Reset change observed" : ""}
      </Text>
      <View className="flex-row flex-wrap justify-between gap-2">
        <Pressable
          className="min-h-11 justify-center px-2"
          accessibilityRole="button"
          disabled={selectedIndex <= 0}
          accessibilityState={{ disabled: selectedIndex <= 0 }}
          onPress={() => setIndex(selectedIndex - 1)}
        >
          <Text className="text-sm text-foreground">Previous reading</Text>
        </Pressable>
        <Pressable
          className="min-h-11 justify-center px-2"
          accessibilityRole="button"
          disabled={selectedIndex >= points.length - 1}
          accessibilityState={{ disabled: selectedIndex >= points.length - 1 }}
          onPress={() => setIndex(selectedIndex + 1)}
        >
          <Text className="text-sm text-foreground">Next reading</Text>
        </Pressable>
      </View>
      <Text className="text-base font-t3-medium text-foreground">
        API-equivalent value by period
      </Text>
      <Text className="text-xs text-foreground-muted">
        Matched usage and estimated value left at each period's last reading. Bars share one dollar
        scale.
      </Text>
      {[...values]
        .sort((a, b) => b.period.id.localeCompare(a.period.id))
        .map(({ period, value }) => (
          <View key={period.id} className="gap-2">
            <Text className="text-xs text-foreground-muted">
              {day(period.first.observedAt)} to {day(period.last.observedAt)}
            </Text>
            {value.cachedAt ? (
              <Text className="text-xs text-foreground-muted">
                Last complete calculation: {new Date(value.cachedAt).toLocaleString()}. Updates
                pending.
              </Text>
            ) : null}
            {[
              { label: "Matched usage", amount: value.costUsd, muted: false },
              { label: "Estimated left", amount: value.remainingValueUsd, muted: true },
            ].map((row) => (
              <View key={row.label} className="gap-1">
                <View className="flex-row flex-wrap justify-between gap-2">
                  <Text className="text-sm text-foreground">{row.label}</Text>
                  <Text className="text-sm text-foreground">
                    {row.amount === null
                      ? "Unavailable"
                      : `${row.muted ? "≈ " : ""}${formatUsd(row.amount)}`}
                  </Text>
                </View>
                {row.amount !== null ? (
                  <View className="h-2" style={{ backgroundColor: `${colors.codex}20` }}>
                    <View
                      className="h-full"
                      style={{
                        width: `${(row.amount / peak) * 100}%`,
                        backgroundColor: colors.codex,
                        opacity: row.muted ? 0.4 : 1,
                      }}
                    />
                  </View>
                ) : null}
              </View>
            ))}
            {value.remainingValueUsd === null && value.reason ? (
              <Text className="text-xs text-foreground-muted">{value.reason}</Text>
            ) : null}
          </View>
        ))}
    </View>
  );
}
