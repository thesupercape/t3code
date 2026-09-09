import { assert, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const suite = layer(NodeSqliteClient.layerMemory());

suite("041_Workers", (it) => {
  it.effect("creates the persisted Worker tables and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 't3_worker%'
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          "t3_worker_activations",
          "t3_worker_approvals",
          "t3_worker_messages",
          "t3_worker_observer_reports",
          "t3_worker_provider_events",
          "t3_worker_wait_leases",
          "t3_workers",
        ],
      );
    }),
  );
});
