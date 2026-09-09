import type { ThreadId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Server-owned Worker queries, lifecycle commands, and live event stream. */
export function createWorkerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workers:list",
    tag: WS_METHODS.workersList,
    staleTimeMs: 2_000,
    refreshIntervalMs: 5_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workers:detail",
    tag: WS_METHODS.workersGet,
    staleTimeMs: 1_000,
    refreshIntervalMs: 3_000,
  });
  const events = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:workers:events",
    tag: WS_METHODS.subscribeWorkers,
  });

  return {
    list,
    detail,
    events,
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:start",
      tag: WS_METHODS.workersStart,
      scheduler: lifecycleScheduler,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:send",
      tag: WS_METHODS.workersSend,
      scheduler: lifecycleScheduler,
    }),
    wait: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:wait",
      tag: WS_METHODS.workersWait,
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
    }),
    observe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:observe",
      tag: WS_METHODS.workersObserve,
      scheduler: lifecycleScheduler,
    }),
    interrupt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:interrupt",
      tag: WS_METHODS.workersInterrupt,
      scheduler: lifecycleScheduler,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:close",
      tag: WS_METHODS.workersClose,
      scheduler: lifecycleScheduler,
    }),
    respondToApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workers:approval-respond",
      tag: WS_METHODS.workersApprovalRespond,
      scheduler: lifecycleScheduler,
    }),
  };
}

export type WorkerEnvironmentAtoms = ReturnType<typeof createWorkerEnvironmentAtoms>;

export function workerListInput(parentThreadId: ThreadId): {
  readonly parentThreadId: ThreadId;
  readonly includeClosed: true;
} {
  return { parentThreadId, includeClosed: true };
}
