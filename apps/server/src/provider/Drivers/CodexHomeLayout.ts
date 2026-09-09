import * as NodeOS from "node:os";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay" | "isolated";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp"]);
const REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = new Set(["mcp-oauth-locks"]);
/** Assets that a T3-owned runtime may read from the configured Codex home. */
const ISOLATED_SHARED_ENTRY_NAMES = new Set(["auth.json", "config.toml", "plugins", "skills"]);
const ISOLATED_COPIED_ENTRY_NAMES = new Set(["auth.json", "config.toml"]);

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

/** Stable private-home location for ordinary T3 Codex instances. */
export function codexIsolatedHomePath(
  path: Path.Path,
  baseDir: string,
  instanceId: string,
): string {
  return path.resolve(path.join(baseDir, "codex-home", instanceId));
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
  options?: { readonly isolatedHomePath?: string },
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    const isolatedHomePath = options?.isolatedHomePath?.trim();
    if (isolatedHomePath) {
      return {
        mode: "isolated",
        sharedHomePath,
        effectiveHomePath: path.resolve(expandHomePath(isolatedHomePath)),
        continuationKey: `codex:home:${sharedHomePath}`,
      };
    }
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "copy",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

export class CodexResumeRolloutMigrationError extends Schema.TaggedError<CodexResumeRolloutMigrationError>()(
  "CodexResumeRolloutMigrationError",
  {
    sharedHomePath: Schema.String,
    effectiveHomePath: Schema.String,
    threadId: Schema.String,
    operation: Schema.Literals(["readDirectory", "makeDirectory", "copy"]),
    path: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not migrate Codex rollout for thread '${this.threadId}' during '${this.operation}' at '${this.path}'.`;
  }
}

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_DIRECTORIES.has(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureIsolatedCopiedEntry = Effect.fn("CodexHomeLayout.ensureIsolatedCopiedEntry")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const source = path.join(input.sharedHomePath, input.entryName);
    const destination = path.join(input.effectiveHomePath, input.entryName);
    const state = yield* readLinkState({
      ...input,
      linkPath: destination,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: destination,
        targetPath: source,
      });
    }
    // Keep a private auth/config file once created so atomic refreshes made by
    // Codex cannot replace a link or write into the desktop home.
    if (state._tag === "NotSymlink") return;
    const contents = yield* input.fileSystem.readFile(source).pipe(
      Effect.mapError(
        (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "copy",
            path: source,
            entryName: input.entryName,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.writeFile(destination, contents, { flag: "wx" }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "AlreadyExists"
            ? Effect.void
            : Effect.fail(
                new CodexShadowHomeFileSystemError({
                  sharedHomePath: input.sharedHomePath,
                  effectiveHomePath: input.effectiveHomePath,
                  operation: "copy",
                  path: destination,
                  entryName: input.entryName,
                  cause,
                }),
              ),
      }),
    );
  },
);

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode === "direct") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* makeDirectory(layout.sharedHomePath);
  yield* makeDirectory(effectiveHomePath);

  // An isolated T3 home intentionally has no links to Codex's transcript,
  // SQLite, cache, log, worktree, or temporary state. Those directories are
  // created by the T3-owned app-server as needed.
  if (layout.mode === "authOverlay") {
    yield* Effect.all(
      KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
      { concurrency: "unbounded" },
    );
  }

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries =
    layout.mode === "isolated"
      ? new Set<string>(
          sharedEntryNames.filter((entryName) => ISOLATED_SHARED_ENTRY_NAMES.has(entryName)),
        )
      : new Set<string>(KNOWN_SHARED_DIRECTORIES);
  if (layout.mode === "authOverlay") {
    for (const entryName of sharedEntryNames) {
      if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
        entries.add(entryName);
      }
    }
  }

  if (layout.mode === "authOverlay") {
    yield* Effect.forEach(
      PRIVATE_ENTRY_NAMES,
      (entryName) =>
        entryName === "auth.json"
          ? Effect.void
          : removePrivateSymlink({
              fileSystem,
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              entryName,
            }),
      { discard: true },
    );
  }

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (layout.mode === "isolated" && ISOLATED_COPIED_ENTRY_NAMES.has(entryName)) {
        return ensureIsolatedCopiedEntry({
          fileSystem,
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          entryName,
        });
      }
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  if (layout.mode === "authOverlay") {
    yield* ensureShadowAuthIsPrivate({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }
});

/**
 * Copies one persisted Codex rollout into an isolated home on first resume.
 * The source is never removed or modified, and only the exact provider thread
 * named by the persisted resume cursor is copied.
 */
export const migrateCodexResumeRollout = Effect.fn("migrateCodexResumeRollout")(function* (input: {
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly resumeThreadId: string | undefined;
}): Effect.fn.Return<void, CodexResumeRolloutMigrationError, FileSystem.FileSystem | Path.Path> {
  if (!input.resumeThreadId || input.sharedHomePath === input.effectiveHomePath) return;
  // Codex rollout filenames encode UUID thread ids. Refuse to turn a
  // persisted value into a path component when it is outside that contract.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.resumeThreadId)
  ) {
    return;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedHomePath = path.resolve(input.sharedHomePath);
  const effectiveHomePath = path.resolve(input.effectiveHomePath);
  const roots = ["sessions", "archived_sessions"];
  const suffix = `-${input.resumeThreadId}.jsonl`;

  const migrationError = (
    operation: CodexResumeRolloutMigrationError["operation"],
    pathValue: string,
    cause: unknown,
  ) =>
    new CodexResumeRolloutMigrationError({
      sharedHomePath,
      effectiveHomePath,
      threadId: input.resumeThreadId!,
      operation,
      path: pathValue,
      ...(typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? { code: cause.code }
        : {}),
      cause,
    });
  const findRollout = Effect.fn("CodexHomeLayout.findRollout")(function* (
    root: string,
  ): Effect.fn.Return<string | undefined, CodexResumeRolloutMigrationError> {
    const entries = yield* fileSystem.readDirectory(root).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(migrationError("readDirectory", root, cause)),
      }),
    );
    for (const entryName of entries) {
      const candidate = path.join(root, entryName);
      const symlink = yield* fileSystem.readLink(candidate).pipe(
        Effect.map(() => true),
        Effect.catchTags({
          PlatformError: (cause) =>
            isNotSymlinkError(cause)
              ? Effect.succeed(false)
              : cause.reason._tag === "NotFound"
                ? Effect.succeed(false)
                : Effect.fail(migrationError("readDirectory", candidate, cause)),
        }),
      );
      if (symlink) continue;
      const isDirectory = yield* fileSystem.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(false)
              : Effect.fail(migrationError("readDirectory", candidate, cause)),
        }),
      );
      if (isDirectory) {
        const found = yield* findRollout(candidate);
        if (found) return found;
      } else if (entryName.endsWith(suffix)) {
        return candidate;
      }
    }
    return undefined;
  });

  // Most resumes are already migrated; keep that path independent of the
  // potentially large legacy home scan.
  for (const rootName of roots) {
    if (yield* findRollout(path.join(effectiveHomePath, rootName))) return;
  }
  for (const rootName of roots) {
    const sourceRoot = path.join(sharedHomePath, rootName);
    const source = yield* findRollout(sourceRoot);
    if (!source) continue;
    const relative = path.relative(sourceRoot, source);
    const destination = path.join(effectiveHomePath, rootName, relative);
    const destinationExists = yield* fileSystem
      .exists(destination)
      .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false) }));
    if (destinationExists) return;
    yield* fileSystem
      .makeDirectory(path.dirname(destination), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          migrationError("makeDirectory", path.dirname(destination), cause),
        ),
      );
    const contents = yield* fileSystem
      .readFile(source)
      .pipe(Effect.mapError((cause) => migrationError("copy", source, cause)));
    const temporary = yield* fileSystem
      .makeTempFile({
        directory: path.dirname(destination),
        prefix: ".t3-codex-resume-",
      })
      .pipe(Effect.mapError((cause) => migrationError("copy", destination, cause)));
    yield* Effect.ensuring(
      fileSystem.writeFile(temporary, contents).pipe(
        Effect.mapError((cause) => migrationError("copy", temporary, cause)),
        Effect.andThen(
          fileSystem.link(temporary, destination).pipe(
            Effect.catchTags({
              PlatformError: (cause) =>
                cause.reason._tag === "AlreadyExists"
                  ? Effect.void
                  : Effect.fail(migrationError("copy", destination, cause)),
            }),
          ),
        ),
      ),
      fileSystem.remove(temporary).pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
    );
    return;
  }
  return yield* new CodexResumeRolloutMigrationError({
    sharedHomePath,
    effectiveHomePath,
    threadId: input.resumeThreadId,
    operation: "readDirectory",
    path: sharedHomePath,
    cause: new Error("The persisted Codex resume rollout was not found."),
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
