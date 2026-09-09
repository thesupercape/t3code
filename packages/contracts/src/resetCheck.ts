import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMaxLength(1200));
export const ResetCheckFinding = Schema.Struct({
  outcome: Schema.Literals(["announced", "possible", "none", "unavailable"]),
  confidence: Schema.Literals(["high", "medium", "low"]),
  summary: Schema.String,
  confidenceReason: Schema.String,
  latestPostsVerified: Schema.Boolean,
  accessNote: Schema.String,
  likelyAt: Schema.NullOr(Schema.String),
  earliestAt: Schema.NullOr(Schema.String),
  latestAt: Schema.NullOr(Schema.String),
  sources: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      publishedAt: Schema.NullOr(Schema.String),
      access: Schema.Literals(["original", "copy", "index"]),
    }),
  ),
});
export type ResetCheckFinding = typeof ResetCheckFinding.Type;

export const ResetCheckState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  result: Schema.NullOr(ResetCheckFinding),
  error: Schema.NullOr(Text),
});
export type ResetCheckState = typeof ResetCheckState.Type;
