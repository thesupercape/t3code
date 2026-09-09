import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import LinkedPullRequestMigration from "./042_ProjectionThreadLinkedPullRequest.ts";

export default Effect.gen(function* () {
  // Migration 42 is already occupied by AuthSessionClientConnection in the
  // worker fork's deployed history. Apply the upstream linked-PR repair here
  // before the branch-PR column so both projection fields exist without
  // reusing an applied migration id.
  yield* LinkedPullRequestMigration;
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "branch_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN branch_pull_request_json TEXT
    `;
  }
});
