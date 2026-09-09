import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BROWSER_NOTIFICATION_PREFERENCES,
  parseBrowserNotificationPreferences,
} from "./browserNotificationPreferences";
import { browserNotificationForTransition, buildWebThreadRoute } from "./browserNotifications";

const running: AgentAwarenessState = {
  environmentId: "env one" as AgentAwarenessState["environmentId"],
  threadId: "thread/one" as AgentAwarenessState["threadId"],
  projectTitle: "T3 Code",
  threadTitle: "Mobile foundation",
  phase: "running",
  headline: "Agent is working",
  modelTitle: "codex",
  updatedAt: "2026-08-23T12:00:00.000Z",
  deepLink: "/threads/env%20one/thread%2Fone",
};

describe("browserNotificationForTransition", () => {
  it("routes actionable transitions to the exact encoded web thread", () => {
    const notification = browserNotificationForTransition({
      previous: running,
      next: {
        ...running,
        phase: "waiting_for_approval",
        headline: "Approval needed",
        updatedAt: "2026-08-23T12:00:01.000Z",
      },
      preferences: { ...DEFAULT_BROWSER_NOTIFICATION_PREFERENCES, enabled: true },
    });

    expect(notification).toEqual({
      title: "Mobile foundation: Approval needed",
      body: "T3 Code",
      route: "/env%20one/thread%2Fone",
      tag: "t3code:env one:thread/one",
    });
  });

  it("does not notify during cache hydration or for repeated phases", () => {
    const preferences = { ...DEFAULT_BROWSER_NOTIFICATION_PREFERENCES, enabled: true };
    expect(
      browserNotificationForTransition({ previous: undefined, next: running, preferences }),
    ).toBeNull();
    expect(
      browserNotificationForTransition({
        previous: running,
        next: { ...running, updatedAt: "2026-08-23T12:00:01.000Z" },
        preferences,
      }),
    ).toBeNull();
  });

  it("honors each event preference and the global switch", () => {
    const completed = { ...running, phase: "completed" as const, headline: "Agent finished" };
    expect(
      browserNotificationForTransition({
        previous: running,
        next: completed,
        preferences: DEFAULT_BROWSER_NOTIFICATION_PREFERENCES,
      }),
    ).toBeNull();
    expect(
      browserNotificationForTransition({
        previous: running,
        next: completed,
        preferences: {
          ...DEFAULT_BROWSER_NOTIFICATION_PREFERENCES,
          enabled: true,
          notifyOnCompletion: false,
        },
      }),
    ).toBeNull();
  });
});

describe("browser notification preferences", () => {
  it("falls back safely and preserves explicit opt-outs", () => {
    expect(parseBrowserNotificationPreferences("not json")).toBe(
      DEFAULT_BROWSER_NOTIFICATION_PREFERENCES,
    );
    expect(
      parseBrowserNotificationPreferences(
        JSON.stringify({
          schemaVersion: 1,
          enabled: true,
          notifyOnApproval: false,
          notifyOnInput: true,
          notifyOnCompletion: true,
          notifyOnFailure: true,
        }),
      ),
    ).toEqual({
      enabled: true,
      notifyOnApproval: false,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    });
  });

  it("uses the canonical browser route rather than the native route", () => {
    expect(buildWebThreadRoute(running)).toBe("/env%20one/thread%2Fone");
  });
});
