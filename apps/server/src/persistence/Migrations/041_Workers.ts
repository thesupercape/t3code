import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ensureWorkerSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_workers (
      worker_id TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_workers_parent_status
    ON t3_workers (parent_thread_id, status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_activations (
      activation_id TEXT PRIMARY KEY NOT NULL,
      worker_id TEXT NOT NULL REFERENCES t3_workers(worker_id) ON DELETE CASCADE,
      provider_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_activations_provider_thread
    ON t3_worker_activations (provider_thread_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_activations_worker
    ON t3_worker_activations (worker_id, activation_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_messages (
      message_id TEXT PRIMARY KEY NOT NULL,
      worker_id TEXT NOT NULL REFERENCES t3_workers(worker_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_messages_worker_created
    ON t3_worker_messages (worker_id, created_at, message_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_approvals (
      request_id TEXT PRIMARY KEY NOT NULL,
      worker_id TEXT NOT NULL REFERENCES t3_workers(worker_id) ON DELETE CASCADE,
      resolved_at TEXT,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_approvals_pending
    ON t3_worker_approvals (worker_id, resolved_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_wait_leases (
      lease_id TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT,
      deadline_at TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_wait_leases_parent
    ON t3_worker_wait_leases (parent_thread_id, status, deadline_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_observer_reports (
      report_id TEXT PRIMARY KEY NOT NULL,
      worker_id TEXT NOT NULL REFERENCES t3_workers(worker_id) ON DELETE CASCADE,
      generated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_observer_reports_worker_generated
    ON t3_worker_observer_reports (worker_id, generated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_worker_provider_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      worker_id TEXT NOT NULL REFERENCES t3_workers(worker_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_t3_worker_provider_events_worker_created
    ON t3_worker_provider_events (worker_id, created_at, event_id)
  `;
});

export default ensureWorkerSchema;
