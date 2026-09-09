import { Schema } from "effect";
import { ThreadId } from "./baseSchemas.ts";

const HttpUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(8_192))
  .check(
    Schema.makeFilter((value) => {
      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === "http:" ||
          parsed.protocol === "https:" ||
          "URL must use the http or https protocol."
        );
      } catch {
        return "URL must be an absolute http or https URL.";
      }
    }),
  )
  .annotate({
    description:
      "Exact absolute HTTP or HTTPS URL to open. Domains are not restricted; long authentication and relay URLs are supported.",
  });

const ChromeNavigateUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(8_192))
  .check(
    Schema.makeFilter((value) => {
      if (value === "about:blank") return true;

      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === "http:" ||
          parsed.protocol === "https:" ||
          "URL must use the http or https protocol, or be exactly about:blank."
        );
      } catch {
        return "URL must be an absolute http or https URL, or exactly about:blank.";
      }
    }),
  )
  .annotate({
    description:
      "Exact absolute HTTP or HTTPS URL to open, or exactly about:blank to reset the selected tab.",
  });

const NonEmptyString = Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty());

export const ComputerChromeLifecycle = Schema.Literals([
  "stopped",
  "starting",
  "connected",
  "stopping",
  "failed",
]);

export const ComputerChromeStatus = Schema.Struct({
  lifecycle: ComputerChromeLifecycle,
  profileDir: Schema.String,
  executablePath: Schema.optionalKey(Schema.String),
  selectedTabId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type ComputerChromeStatus = typeof ComputerChromeStatus.Type;

export const ComputerChromeTab = Schema.Struct({
  id: NonEmptyString,
  url: Schema.String,
  title: Schema.String,
  selected: Schema.Boolean,
});
export type ComputerChromeTab = typeof ComputerChromeTab.Type;

export const ComputerChromeRef = Schema.Struct({
  ref: NonEmptyString,
  selector: NonEmptyString,
  tag: NonEmptyString,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ComputerChromeRef = typeof ComputerChromeRef.Type;

export const ComputerChromeSnapshot = Schema.Struct({
  tabId: NonEmptyString,
  accessibilityTree: Schema.String,
  dom: Schema.optionalKey(Schema.String),
  refs: Schema.Array(ComputerChromeRef),
});
export type ComputerChromeSnapshot = typeof ComputerChromeSnapshot.Type;

export const ComputerChromeSnapshotInput = Schema.Struct({
  tabId: NonEmptyString,
  includeDom: Schema.optionalKey(Schema.Boolean),
});
export type ComputerChromeSnapshotInput = typeof ComputerChromeSnapshotInput.Type;
export const ComputerChromeScreenshot = Schema.Struct({
  tabId: NonEmptyString,
  mimeType: Schema.Literal("image/png"),
  data: Schema.String.check(Schema.isMaxLength(6_990_508)),
  width: Schema.Number.check(Schema.isInt()).check(
    Schema.isBetween({ minimum: 1, maximum: 4_096 }),
  ),
  height: Schema.Number.check(Schema.isInt()).check(
    Schema.isBetween({ minimum: 1, maximum: 4_096 }),
  ),
});
export type ComputerChromeScreenshot = typeof ComputerChromeScreenshot.Type;

/** Persisted image pointer, without image bytes, host paths, or expiring access tokens. */
export const ToolScreenshot = Schema.Struct({
  threadId: ThreadId,
  attachmentId: Schema.String.check(Schema.isMaxLength(117)).check(
    Schema.isPattern(
      /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ),
  ),
  mimeType: Schema.Literal("image/png"),
  width: ComputerChromeScreenshot.fields.width,
  height: ComputerChromeScreenshot.fields.height,
});
export type ToolScreenshot = typeof ToolScreenshot.Type;

// Effect 4 rc requires MCP parameter schemas to render as a top-level JSON
// object. A truly empty Struct currently renders as object-or-array, so keep a
// never-valued optional marker to preserve the no-argument API and object shape.
export const ComputerChromeEmptyInput = Schema.Struct({
  _unused: Schema.optionalKey(Schema.Never),
});
export type ComputerChromeEmptyInput = typeof ComputerChromeEmptyInput.Type;

export const ComputerChromeSelectTabInput = Schema.Struct({ tabId: NonEmptyString });
export type ComputerChromeSelectTabInput = typeof ComputerChromeSelectTabInput.Type;

const ComputerChromeTarget = Schema.Union([
  Schema.Struct({ ref: NonEmptyString }),
  Schema.Struct({ selector: NonEmptyString }),
]);

export const ComputerChromeNavigateInput = Schema.Struct({
  tabId: NonEmptyString,
  url: ChromeNavigateUrl,
  waitUntil: Schema.optionalKey(Schema.Literals(["load", "domcontentloaded", "commit"])),
  timeoutMs: Schema.optionalKey(
    Schema.Number.check(Schema.isInt()).check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
  ),
});
export type ComputerChromeNavigateInput = typeof ComputerChromeNavigateInput.Type;

export const ComputerChromeTargetInput = Schema.Struct({
  tabId: NonEmptyString,
  target: ComputerChromeTarget,
});
export type ComputerChromeTargetInput = typeof ComputerChromeTargetInput.Type;

export const ComputerChromeValueInput = Schema.Struct({
  tabId: NonEmptyString,
  target: ComputerChromeTarget,
  value: Schema.String,
});
export type ComputerChromeValueInput = typeof ComputerChromeValueInput.Type;

export const ComputerChromeActionResult = Schema.Struct({ completed: Schema.Literal(true) });
export type ComputerChromeActionResult = typeof ComputerChromeActionResult.Type;

export const ComputerOpenUrlInput = Schema.Struct({ url: HttpUrl });
export type ComputerOpenUrlInput = typeof ComputerOpenUrlInput.Type;

export const ComputerOpenUrlResult = Schema.Struct({
  opened: Schema.Literal(true),
});
export type ComputerOpenUrlResult = typeof ComputerOpenUrlResult.Type;

export class ComputerControlUnavailableError extends Schema.TaggedError<ComputerControlUnavailableError>()(
  "ComputerControlUnavailableError",
  {
    message: Schema.String,
  },
) {}

export class ComputerOpenUrlFailedError extends Schema.TaggedError<ComputerOpenUrlFailedError>()(
  "ComputerOpenUrlFailedError",
  {
    message: Schema.String,
  },
) {}

export class ComputerChromeAutomationError extends Schema.TaggedError<ComputerChromeAutomationError>()(
  "ComputerChromeAutomationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
