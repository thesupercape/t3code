import type {
  ApprovalRequestId,
  ModelSelection,
  ProviderRuntimeEvent,
  WorkerActivation,
  WorkerApprovalRequest,
  WorkerDetail,
  WorkerMessage,
  WorkerObserverReport,
  WorkerSummary,
  OrchestrationThreadActivity,
  TurnId,
  WorkerWaitLeaseId,
  WorkerWaitLeaseStatus,
  WorkerWakeReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface StoredWorker {
  readonly summary: WorkerSummary;
  readonly assignment: string;
  readonly context: WorkerDetail["context"];
  /** Exact inherited provider selection, including control mode and reasoning options. */
  readonly modelSelection?: ModelSelection | undefined;
  readonly instructions?: string | undefined;
  readonly parentTurnId?: TurnId | undefined;
  readonly discardedAt?: string | undefined;
  readonly discardedByRequestId?: string | undefined;
}

export interface StoredWaitLease {
  readonly leaseId: WorkerWaitLeaseId;
  readonly parentThreadId?: string | undefined;
  readonly workerIds: ReadonlyArray<string>;
  readonly deadlineAt: string;
  readonly status: WorkerWaitLeaseStatus;
  readonly wakeReason?: WorkerWakeReason | undefined;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
}

export interface WorkerProviderThreadMatch {
  readonly workerId: StoredWorker["summary"]["id"];
  readonly activationId: WorkerActivation["id"];
}

export interface WorkerStoreShape {
  readonly saveWorker: (worker: StoredWorker) => Effect.Effect<void, PersistenceSqlError>;
  readonly getWorker: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<Option.Option<StoredWorker>, PersistenceSqlError>;
  readonly listWorkers: (input: {
    readonly parentThreadId?: string | undefined;
    readonly includeClosed: boolean;
    readonly includeDiscarded?: boolean | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<StoredWorker>, PersistenceSqlError>;
  readonly saveActivation: (
    activation: WorkerActivation,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getActivation: (
    activationId: WorkerActivation["id"],
  ) => Effect.Effect<Option.Option<WorkerActivation>, PersistenceSqlError>;
  readonly listActivations: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<ReadonlyArray<WorkerActivation>, PersistenceSqlError>;
  readonly findProviderActivation: (input: {
    readonly providerThreadId: string;
    readonly providerTurnId?: string | undefined;
  }) => Effect.Effect<Option.Option<WorkerProviderThreadMatch>, PersistenceSqlError>;
  readonly saveMessage: (message: WorkerMessage) => Effect.Effect<void, PersistenceSqlError>;
  readonly listMessages: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<ReadonlyArray<WorkerMessage>, PersistenceSqlError>;
  readonly saveApproval: (
    approval: WorkerApprovalRequest,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getPendingApproval: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<Option.Option<WorkerApprovalRequest>, PersistenceSqlError>;
  readonly resolveApproval: (input: {
    readonly requestId: ApprovalRequestId;
    readonly decision: WorkerApprovalRequest["decision"];
    readonly resolvedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly saveObserverReport: (
    report: WorkerObserverReport,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listObserverReports: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<ReadonlyArray<WorkerObserverReport>, PersistenceSqlError>;
  readonly saveWaitLease: (lease: StoredWaitLease) => Effect.Effect<void, PersistenceSqlError>;
  readonly finishWaitLease: (input: {
    readonly leaseId: WorkerWaitLeaseId;
    readonly status: Exclude<WorkerWaitLeaseStatus, "waiting">;
    readonly reason: WorkerWakeReason;
    readonly completedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly appendProviderEvent: (input: {
    readonly eventId: string;
    readonly workerId: StoredWorker["summary"]["id"];
    readonly createdAt: string;
    readonly eventType: string;
    readonly payload: unknown;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly listProviderEvents: (
    workerId: StoredWorker["summary"]["id"],
  ) => Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>, PersistenceSqlError>;
  /** Optional for isolated test stores; the live store reads the canonical parent projection. */
  readonly listParentActivities?: (
    parentThreadId: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, PersistenceSqlError>;
}

export class WorkerStore extends Context.Service<WorkerStore, WorkerStoreShape>()(
  "t3/worker/WorkerStore",
) {}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const makeWorkerStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <A>(operation: string, effect: Effect.Effect<A, SqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));

  const saveWorker: WorkerStoreShape["saveWorker"] = (worker) =>
    query(
      "WorkerStore.saveWorker",
      sql`
        INSERT INTO t3_workers (worker_id, parent_thread_id, status, updated_at, payload_json)
        VALUES (${worker.summary.id}, ${worker.summary.parentThreadId}, ${worker.summary.status}, ${worker.summary.updatedAt}, ${JSON.stringify(worker)})
        ON CONFLICT (worker_id) DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const getWorker: WorkerStoreShape["getWorker"] = (workerId) =>
    query(
      "WorkerStore.getWorker",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM t3_workers WHERE worker_id = ${workerId} LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some(parseJson<StoredWorker>(rows[0]!.payload_json)),
        ),
      ),
    );

  const listWorkers: WorkerStoreShape["listWorkers"] = (input) =>
    query(
      "WorkerStore.listWorkers",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_workers
        WHERE (${input.parentThreadId ?? null} IS NULL OR parent_thread_id = ${input.parentThreadId ?? null})
          AND (${input.includeClosed ? 1 : 0} = 1 OR status <> 'closed')
          AND (${input.includeDiscarded ? 1 : 0} = 1 OR json_extract(payload_json, '$.discardedAt') IS NULL)
        ORDER BY updated_at DESC, worker_id DESC
        LIMIT ${input.limit}
      `.pipe(
        Effect.map((rows) =>
          rows
            .map((row) => parseJson<StoredWorker>(row.payload_json))
            .filter((worker) => input.includeDiscarded || worker.discardedAt === undefined),
        ),
      ),
    );

  const saveActivation: WorkerStoreShape["saveActivation"] = (activation) =>
    query(
      "WorkerStore.saveActivation",
      sql`
        INSERT INTO t3_worker_activations (activation_id, worker_id, provider_thread_id, status, payload_json)
        VALUES (${activation.id}, ${activation.workerId}, ${activation.providerThreadId}, ${activation.status}, ${JSON.stringify(activation)})
        ON CONFLICT (activation_id) DO UPDATE SET
          provider_thread_id = excluded.provider_thread_id,
          status = excluded.status,
          payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const getActivation: WorkerStoreShape["getActivation"] = (activationId) =>
    query(
      "WorkerStore.getActivation",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM t3_worker_activations WHERE activation_id = ${activationId} LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some(parseJson<WorkerActivation>(rows[0]!.payload_json)),
        ),
      ),
    );

  const listActivations: WorkerStoreShape["listActivations"] = (workerId) =>
    query(
      "WorkerStore.listActivations",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_worker_activations
        WHERE worker_id = ${workerId}
        ORDER BY json_extract(payload_json, '$.startedAt') ASC, activation_id ASC
      `.pipe(
        Effect.map((rows) => rows.map((row) => parseJson<WorkerActivation>(row.payload_json))),
      ),
    );

  const findProviderActivation: WorkerStoreShape["findProviderActivation"] = (input) =>
    query(
      "WorkerStore.findProviderActivation",
      sql<{ readonly worker_id: string; readonly activation_id: string }>`
        SELECT worker_id, activation_id
        FROM t3_worker_activations
        WHERE provider_thread_id = ${input.providerThreadId}
          AND (
            ${input.providerTurnId ?? null} IS NULL
            OR json_extract(payload_json, '$.providerTurnId') = ${input.providerTurnId ?? null}
            OR (
              json_extract(payload_json, '$.providerTurnId') IS NULL
              AND status = 'starting'
            )
          )
        ORDER BY
          CASE
            WHEN json_extract(payload_json, '$.providerTurnId') = ${input.providerTurnId ?? null}
              THEN 0
            WHEN status NOT IN ('completed', 'failed', 'interrupted', 'lost') THEN 1
            ELSE 2
          END,
          json_extract(payload_json, '$.startedAt') DESC,
          activation_id DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some({
                workerId: rows[0]!.worker_id as StoredWorker["summary"]["id"],
                activationId: rows[0]!.activation_id as WorkerActivation["id"],
              }),
        ),
      ),
    );

  const saveMessage: WorkerStoreShape["saveMessage"] = (message) =>
    query(
      "WorkerStore.saveMessage",
      sql`
        INSERT INTO t3_worker_messages (message_id, worker_id, created_at, payload_json)
        VALUES (${message.id}, ${message.workerId}, ${message.createdAt}, ${JSON.stringify(message)})
        ON CONFLICT (message_id) DO UPDATE SET payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const listMessages: WorkerStoreShape["listMessages"] = (workerId) =>
    query(
      "WorkerStore.listMessages",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_worker_messages
        WHERE worker_id = ${workerId}
        ORDER BY created_at ASC, message_id ASC
      `.pipe(Effect.map((rows) => rows.map((row) => parseJson<WorkerMessage>(row.payload_json)))),
    );

  const saveApproval: WorkerStoreShape["saveApproval"] = (approval) =>
    query(
      "WorkerStore.saveApproval",
      sql`
        INSERT INTO t3_worker_approvals (request_id, worker_id, resolved_at, payload_json)
        VALUES (${approval.requestId}, ${approval.workerId}, ${approval.resolvedAt ?? null}, ${JSON.stringify(approval)})
        ON CONFLICT (request_id) DO UPDATE SET
          resolved_at = excluded.resolved_at,
          payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const getPendingApproval: WorkerStoreShape["getPendingApproval"] = (workerId) =>
    query(
      "WorkerStore.getPendingApproval",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_worker_approvals
        WHERE worker_id = ${workerId} AND resolved_at IS NULL
        ORDER BY request_id DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some(parseJson<WorkerApprovalRequest>(rows[0]!.payload_json)),
        ),
      ),
    );

  const resolveApproval: WorkerStoreShape["resolveApproval"] = (input) =>
    query(
      "WorkerStore.resolveApproval",
      sql`
        UPDATE t3_worker_approvals
        SET resolved_at = ${input.resolvedAt},
            payload_json = json_set(payload_json, '$.status', 'resolved', '$.resolvedAt', ${input.resolvedAt}, '$.decision', ${input.decision ?? null})
        WHERE request_id = ${input.requestId}
      `.pipe(Effect.asVoid),
    );

  const saveObserverReport: WorkerStoreShape["saveObserverReport"] = (report) =>
    query(
      "WorkerStore.saveObserverReport",
      sql`
        INSERT INTO t3_worker_observer_reports (report_id, worker_id, generated_at, payload_json)
        VALUES (${report.id}, ${report.workerId}, ${report.generatedAt}, ${JSON.stringify(report)})
        ON CONFLICT (report_id) DO UPDATE SET payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const listObserverReports: WorkerStoreShape["listObserverReports"] = (workerId) =>
    query(
      "WorkerStore.listObserverReports",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_worker_observer_reports
        WHERE worker_id = ${workerId}
        ORDER BY generated_at DESC, report_id DESC
      `.pipe(
        Effect.map((rows) => rows.map((row) => parseJson<WorkerObserverReport>(row.payload_json))),
      ),
    );

  const saveWaitLease: WorkerStoreShape["saveWaitLease"] = (lease) =>
    query(
      "WorkerStore.saveWaitLease",
      sql`
        INSERT INTO t3_worker_wait_leases (lease_id, parent_thread_id, deadline_at, status, payload_json)
        VALUES (${lease.leaseId}, ${lease.parentThreadId ?? null}, ${lease.deadlineAt}, ${lease.status}, ${JSON.stringify(lease)})
        ON CONFLICT (lease_id) DO UPDATE SET
          status = excluded.status,
          payload_json = excluded.payload_json
      `.pipe(Effect.asVoid),
    );

  const finishWaitLease: WorkerStoreShape["finishWaitLease"] = (input) =>
    query(
      "WorkerStore.finishWaitLease",
      sql`
        UPDATE t3_worker_wait_leases
        SET status = ${input.status},
            payload_json = json_set(payload_json, '$.status', ${input.status}, '$.wakeReason', ${input.reason}, '$.completedAt', ${input.completedAt})
        WHERE lease_id = ${input.leaseId} AND status = 'waiting'
      `.pipe(Effect.asVoid),
    );

  const appendProviderEvent: WorkerStoreShape["appendProviderEvent"] = (input) =>
    query(
      "WorkerStore.appendProviderEvent",
      sql`
        INSERT OR IGNORE INTO t3_worker_provider_events (event_id, worker_id, created_at, event_type, payload_json)
        VALUES (${input.eventId}, ${input.workerId}, ${input.createdAt}, ${input.eventType}, ${JSON.stringify(input.payload)})
      `.pipe(Effect.asVoid),
    );

  const listProviderEvents: WorkerStoreShape["listProviderEvents"] = (workerId) =>
    query(
      "WorkerStore.listProviderEvents",
      sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM t3_worker_provider_events
        WHERE worker_id = ${workerId}
          AND event_type <> 'content.delta'
        ORDER BY created_at ASC, event_id ASC
      `.pipe(
        Effect.map((rows) => rows.map((row) => parseJson<ProviderRuntimeEvent>(row.payload_json))),
      ),
    );

  const listParentActivities: NonNullable<WorkerStoreShape["listParentActivities"]> = (
    parentThreadId,
  ) =>
    query(
      "WorkerStore.listParentActivities",
      sql<{
        activityId: string;
        tone: OrchestrationThreadActivity["tone"];
        kind: string;
        summary: string;
        payloadJson: string;
        turnId: string | null;
        sequence: number | null;
        createdAt: string;
      }>`
          SELECT
            activity_id AS "activityId",
            tone,
            kind,
            summary,
            payload_json AS "payloadJson",
            turn_id AS "turnId",
            sequence,
            created_at AS "createdAt"
          FROM projection_thread_activities
          WHERE thread_id = ${parentThreadId}
          ORDER BY sequence ASC, created_at ASC, activity_id ASC
        `.pipe(
        Effect.map((rows) =>
          rows.map(
            (row) =>
              ({
                id: row.activityId,
                tone: row.tone,
                kind: row.kind,
                summary: row.summary,
                payload: parseJson<unknown>(row.payloadJson),
                turnId: row.turnId,
                ...(row.sequence === null ? {} : { sequence: row.sequence }),
                createdAt: row.createdAt,
              }) as OrchestrationThreadActivity,
          ),
        ),
      ),
    );

  return {
    saveWorker,
    getWorker,
    listWorkers,
    saveActivation,
    getActivation,
    listActivations,
    findProviderActivation,
    saveMessage,
    listMessages,
    saveApproval,
    getPendingApproval,
    resolveApproval,
    saveObserverReport,
    listObserverReports,
    saveWaitLease,
    finishWaitLease,
    appendProviderEvent,
    listProviderEvents,
    listParentActivities,
  } satisfies WorkerStoreShape;
});

export const WorkerStoreLive = Layer.effect(WorkerStore, makeWorkerStore);
