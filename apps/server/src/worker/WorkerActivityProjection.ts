import {
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
  type WorkerActivity,
} from "@t3tools/contracts";

import { projectActivityPayload } from "../orchestration/ActivityPayloadProjection.ts";

const MAX_DETAIL_LENGTH = 600;

function truncate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= MAX_DETAIL_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, path: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of path) current = record(current)?.[key];
  return typeof current === "string" ? truncate(current) : undefined;
}

function projectedToolResult(event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>) {
  const projected = projectActivityPayload({
    id: event.eventId,
    tone: "tool",
    kind: "tool.completed",
    summary: event.payload.title ?? "Tool completed",
    payload: {
      itemType: event.payload.itemType,
      ...(event.payload.data === undefined ? {} : { data: event.payload.data }),
    },
    turnId: event.turnId ?? null,
    createdAt: event.createdAt,
  });
  const payload = record(projected.payload);
  return (
    stringAt(payload, ["data", "item", "aggregatedOutput"]) ??
    stringAt(payload, ["data", "item", "result", "content"]) ??
    stringAt(payload, ["data", "rawOutput", "content"])
  );
}

function projectedToolFailed(event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>) {
  const data = record(event.payload.data);
  const item = record(data?.item);
  const status =
    (typeof item?.status === "string" ? item.status : undefined) ?? event.payload.status;
  const hasError = (value: unknown) => value !== undefined && value !== null && value !== false;
  return (
    status === "failed" ||
    status === "declined" ||
    item?.isError === true ||
    data?.isError === true ||
    hasError(item?.error) ||
    hasError(data?.error)
  );
}

function toolCorrelationKey(event: ProviderRuntimeEvent): string | undefined {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }
  if (!isToolLifecycleItemType(event.payload.itemType)) return undefined;
  const itemId = event.itemId ?? event.providerRefs?.providerItemId;
  return itemId === undefined
    ? undefined
    : `${event.threadId}:${event.turnId ?? "unscoped"}:${itemId}`;
}

/**
 * Converts persisted provider events into the read-only Worker timeline.
 * Streaming model content, reasoning, session configuration, and raw payloads
 * are intentionally omitted. Tool output passes through the same compact
 * projection used by the parent task activity feed.
 */
export function projectWorkerActivity(event: ProviderRuntimeEvent): WorkerActivity | undefined {
  switch (event.type) {
    case "item.started":
    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) return undefined;
      const stage = event.type === "item.started" ? "started" : "updated";
      const detail = truncate(event.payload.detail);
      return {
        id: event.eventId,
        tone: "tool",
        kind: `tool.${stage}`,
        title: event.payload.title ?? "Tool",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) return undefined;
      const detail = truncate(event.payload.detail);
      const result = projectedToolResult(event);
      const failed = projectedToolFailed(event);
      return {
        id: event.eventId,
        tone: "tool",
        kind: failed ? "tool.failed" : "tool.completed",
        title: event.payload.title ?? "Tool",
        ...(detail ? { detail } : {}),
        ...(result ? { result } : {}),
        createdAt: event.createdAt,
      };
    }
    case "tool.progress": {
      const detail = truncate(event.payload.summary);
      return {
        id: event.eventId,
        tone: "tool",
        kind: "tool.progress",
        title: event.payload.toolName ?? "Tool progress",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "tool.summary": {
      const detail = truncate(event.payload.summary);
      return {
        id: event.eventId,
        tone: "tool",
        kind: "tool.summary",
        title: "Tool summary",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") return undefined;
      const detail = truncate(event.payload.detail);
      return {
        id: event.eventId,
        tone: "approval",
        kind: "approval.requested",
        title: "Approval requested",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "request.resolved":
      if (event.payload.requestType === "tool_user_input") return undefined;
      return {
        id: event.eventId,
        tone: "approval",
        kind: "approval.resolved",
        title: "Approval resolved",
        ...(event.payload.decision ? { detail: event.payload.decision } : {}),
        createdAt: event.createdAt,
      };
    case "turn.started":
      return {
        id: event.eventId,
        tone: "info",
        kind: "turn.started",
        title: "Worker turn started",
        createdAt: event.createdAt,
      };
    case "turn.completed": {
      const detail = truncate(event.payload.errorMessage);
      return {
        id: event.eventId,
        tone: event.payload.state === "failed" ? "error" : "info",
        kind: "turn.completed",
        title: event.payload.state === "failed" ? "Worker turn failed" : "Worker turn completed",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "turn.aborted": {
      const detail = truncate(event.payload.reason);
      return {
        id: event.eventId,
        tone: "error",
        kind: "turn.aborted",
        title: "Worker turn stopped",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    case "runtime.warning":
    case "runtime.error": {
      const detail = truncate(event.payload.message);
      return {
        id: event.eventId,
        tone: event.type === "runtime.error" ? "error" : "info",
        kind: event.type,
        title: event.type === "runtime.error" ? "Runtime error" : "Runtime warning",
        ...(detail ? { detail } : {}),
        createdAt: event.createdAt,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Projects an ordered provider-event stream and folds lifecycle updates for
 * the same canonical provider item into one client-safe tool row. The first
 * event fixes the row's position; the latest terminal event supplies status,
 * detail, and result. Events without a provider item identity stay separate.
 */
export function projectWorkerActivities(
  events: ReadonlyArray<ProviderRuntimeEvent>,
): ReadonlyArray<WorkerActivity> {
  const activities: WorkerActivity[] = [];
  const correlatedToolIndexes = new Map<string, number>();

  for (const event of events) {
    const activity = projectWorkerActivity(event);
    if (activity === undefined) continue;
    const key = toolCorrelationKey(event);
    if (key === undefined) {
      activities.push(activity);
      continue;
    }

    const existingIndex = correlatedToolIndexes.get(key);
    if (existingIndex === undefined) {
      correlatedToolIndexes.set(key, activities.length);
      activities.push(activity);
      continue;
    }

    const existing = activities[existingIndex]!;
    const existingTerminal = existing.kind === "tool.completed" || existing.kind === "tool.failed";
    const nextTerminal = activity.kind === "tool.completed" || activity.kind === "tool.failed";
    if (existingTerminal && !nextTerminal) continue;
    activities[existingIndex] = {
      ...activity,
      id: existing.id,
      createdAt: existing.createdAt,
      ...(activity.detail === undefined && existing.detail !== undefined
        ? { detail: existing.detail }
        : {}),
      ...(activity.result === undefined && existing.result !== undefined
        ? { result: existing.result }
        : {}),
    };
  }

  return activities;
}
