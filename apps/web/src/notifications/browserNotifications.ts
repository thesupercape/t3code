import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  projectThreadAwareness,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";

import type { BrowserNotificationPreferences } from "./browserNotificationPreferences";

export interface BrowserThreadNotification {
  readonly title: string;
  readonly body: string;
  readonly route: string;
  readonly tag: string;
}

export function browserThreadKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return scopedThreadKey(scopeThreadRef(input.environmentId, input.threadId));
}

export function buildWebThreadRoute(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function buildBrowserAwarenessSnapshot(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, AgentAwarenessState> {
  const projectsByKey = new Map(
    projects.map(
      (project) =>
        [scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), project] as const,
    ),
  );
  const states = new Map<string, AgentAwarenessState>();
  for (const thread of threads) {
    const project = projectsByKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    if (!project) continue;
    const state = projectThreadAwareness({
      environmentId: thread.environmentId,
      project,
      thread,
    });
    if (state) states.set(browserThreadKey(state), state);
  }
  return states;
}

function preferenceAllows(
  phase: AgentAwarenessPhase,
  preferences: BrowserNotificationPreferences,
): boolean {
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    case "starting":
    case "running":
    case "stale":
      return false;
  }
}

export function browserNotificationForTransition(input: {
  readonly previous: AgentAwarenessState | undefined;
  readonly next: AgentAwarenessState;
  readonly preferences: BrowserNotificationPreferences;
}): BrowserThreadNotification | null {
  if (
    !input.preferences.enabled ||
    input.previous === undefined ||
    input.previous.phase === input.next.phase ||
    !preferenceAllows(input.next.phase, input.preferences)
  ) {
    return null;
  }

  return {
    title: `${input.next.threadTitle}: ${input.next.headline}`,
    body: input.next.detail ?? input.next.projectTitle,
    route: buildWebThreadRoute(input.next),
    tag: `t3code:${browserThreadKey(input.next)}`,
  };
}
