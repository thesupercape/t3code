import { WorkerOperationError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { rejectWorkerLifecycleWebSocketControl } from "./ws.ts";

it.effect("denies human WebSocket Worker lifecycle mutations", () =>
  Effect.gen(function* () {
    for (const operation of [
      "worker.start",
      "worker.send",
      "worker.interrupt",
      "worker.close",
      "worker.approvalRespond",
    ]) {
      const error = yield* rejectWorkerLifecycleWebSocketControl(operation).pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorkerOperationError);
      expect(error.operation).toBe(operation);
      expect(error.message).toBe(
        "Worker lifecycle control is available only to parent agents through MCP.",
      );
    }
  }),
);
