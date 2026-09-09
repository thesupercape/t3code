import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0042 from "./042_AuthSessionClientConnection.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_AuthSessionClientConnection", (it) => {
  it.effect("reconciles both historical migration 41 schemas", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const surface = columns.find((column) => column.name === "client_surface");
      const appVersion = columns.find((column) => column.name === "client_app_version");

      assert.equal(surface?.name, "client_surface");
      assert.equal(surface?.notnull, 0);
      assert.equal(appVersion?.name, "client_app_version");
      assert.equal(appVersion?.notnull, 0);

      // Simulate the upstream history: auth columns exist at 41, Workers do not.
      yield* sql`DROP TABLE t3_worker_provider_events`;
      yield* sql`DROP TABLE t3_worker_observer_reports`;
      yield* sql`DROP TABLE t3_worker_wait_leases`;
      yield* sql`DROP TABLE t3_worker_approvals`;
      yield* sql`DROP TABLE t3_worker_messages`;
      yield* sql`DROP TABLE t3_worker_activations`;
      yield* sql`DROP TABLE t3_workers`;
      yield* Migration0042;
      const workerTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 't3_workers'
      `;
      assert.equal(workerTables[0]?.name, "t3_workers");

      // Simulate this fork's history: Worker tables exist at 41, auth columns do not.
      yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_surface`;
      yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_app_version`;
      yield* Migration0042;
      const reconciledColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.ok(reconciledColumns.some((column) => column.name === "client_surface"));
      assert.ok(reconciledColumns.some((column) => column.name === "client_app_version"));
    }),
  );
});
