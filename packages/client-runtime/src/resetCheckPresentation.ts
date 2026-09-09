import type { ResetCheckState } from "@t3tools/contracts";

/** Command replies and poll replies may arrive out of order. */
export function latestResetCheck<State extends Pick<ResetCheckState, "startedAt" | "finishedAt">>(
  remote: State | null,
  command: State | null,
) {
  if (!remote) return command;
  if (!command) return remote;
  const timestamp = (state: State) => Date.parse(state.finishedAt ?? state.startedAt ?? "") || 0;
  return timestamp(command) > timestamp(remote) ? command : remote;
}

export const communityPostLabels = {
  reset_reported: "User reports a reset",
  still_waiting: "User still waiting",
  question: "Question",
  speculation: "Speculation",
  reaction: "Reaction",
} as const;

export function researchCheckDate(value: string | null) {
  return value === null
    ? "Time not verified"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(Date.parse(value));
}

export function resetCheckPresentation(state: ResetCheckState | null) {
  const finding = state?.result;
  const date = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(Date.parse(value));
  const range =
    finding?.earliestAt && finding.latestAt
      ? Date.parse(finding.earliestAt) === Date.parse(finding.latestAt)
        ? date(finding.earliestAt)
        : `${date(finding.earliestAt)} to ${date(finding.latestAt)}`
      : null;
  return {
    title: finding
      ? {
          announced: "Reset announced",
          possible: "Possible reset",
          none: "No upcoming reset found",
          unavailable: "Could not verify reset news",
        }[finding.outcome]
      : null,
    range,
    likely: finding?.likelyAt ? date(finding.likelyAt) : null,
    checked: state?.finishedAt ? date(state.finishedAt) : null,
    confidence: finding
      ? `${finding.confidence[0]!.toUpperCase()}${finding.confidence.slice(1)} confidence in timing`
      : null,
  };
}
