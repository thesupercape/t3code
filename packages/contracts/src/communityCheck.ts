import * as Schema from "effect/Schema";

const Text = Schema.String;
export const CommunityCheckFinding = Schema.Struct({
  outcome: Schema.Literals(["found", "none", "unavailable"]),
  summary: Text,
  coverage: Schema.Literals(["live", "partial", "unavailable"]),
  accessNote: Text,
  posts: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      author: Schema.String,
      publishedAt: Schema.NullOr(Schema.String),
      access: Schema.Literals(["original", "copy", "index"]),
      kind: Schema.Literals([
        "reset_reported",
        "still_waiting",
        "question",
        "speculation",
        "reaction",
      ]),
      summary: Text,
    }),
  ),
});
export type CommunityCheckFinding = typeof CommunityCheckFinding.Type;

export const CommunityCheckState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  result: Schema.NullOr(CommunityCheckFinding),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1200))),
});
export type CommunityCheckState = typeof CommunityCheckState.Type;
