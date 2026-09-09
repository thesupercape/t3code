import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("050_ProjectionThreadsSchemaCompatibility", (it) => {
  it.effect("repairs historical migration IDs without changing existing thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-compat', 'project-compat', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (48, '2026-01-01T00:00:00.000Z', 'ProjectionThreadLinkedPullRequestCompatibility')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (49, '2026-01-01T00:00:00.000Z', 'WorkersCompatibility')
      `;
      yield* runMigrations({ toMigrationInclusive: 50 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      const rows = yield* sql<{
        readonly activeOrderKey: string | null;
        readonly branchPullRequest: string | null;
      }>`
        SELECT active_order_key AS "activeOrderKey", branch_pull_request_json AS "branchPullRequest"
        FROM projection_threads WHERE thread_id = 'thread-compat'
      `;
      const count = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM projection_threads`;
      const history = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM effect_sql_migrations WHERE migration_id = 50`;
      assert.isTrue(columns.some((column) => column.name === "active_order_key"));
      assert.isTrue(columns.some((column) => column.name === "branch_pull_request_json"));
      assert.deepEqual(rows, [{ activeOrderKey: null, branchPullRequest: null }]);
      assert.deepEqual(count, [{ count: 1 }]);
      assert.deepEqual(history, [{ count: 1 }]);
    }),
  );
});
