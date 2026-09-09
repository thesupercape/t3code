import type { ServerNotification__PatchChangeKind } from "effect-codex-app-server/schema";

const MAX_PENDING_ITEMS = 32;
const MAX_PREVIEW_CHARS = 64_000;
const TRUNCATED = "\n[Preview truncated. Review the complete file-change item before approving.]";

interface ItemIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

interface FileChange {
  readonly path: string;
  readonly kind: ServerNotification__PatchChangeKind;
  readonly diff: string;
}

function previewChanges(changes: ReadonlyArray<FileChange>): string {
  let preview = `${changes.length} proposed file change${changes.length === 1 ? "" : "s"}:\n`;
  let truncated = false;
  const append = (text: string) => {
    const remaining = MAX_PREVIEW_CHARS - preview.length;
    if (text.length > remaining) truncated = true;
    preview += text.slice(0, remaining);
  };
  // Put the affected paths before diff text so a large first file does not
  // hide the rest of the proposed scope.
  for (const change of changes) {
    append(
      `${change.kind.type.toUpperCase()} ${change.path}${change.kind.type === "update" && change.kind.move_path ? ` -> ${change.kind.move_path}` : ""}\n`,
    );
    if (truncated) break;
  }
  if (!truncated) {
    for (const [index, change] of changes.entries()) {
      append(`\nChange ${index + 1} diff:\n`);
      append(change.diff || "[No diff supplied]");
      append("\n");
      if (truncated) break;
    }
  }
  return truncated ? preview.slice(0, MAX_PREVIEW_CHARS - TRUNCATED.length) + TRUNCATED : preview;
}

/** Per-session, consume-on-request context. Stores bounded text, not raw diffs. */
export function makeCodexFileChangeApprovalContext() {
  let entries: Array<ItemIdentity & { readonly detail: string }> = [];
  const matches = (entry: ItemIdentity, identity: ItemIdentity) =>
    entry.threadId === identity.threadId &&
    entry.turnId === identity.turnId &&
    entry.itemId === identity.itemId;
  return {
    remember(identity: ItemIdentity, changes: ReadonlyArray<FileChange>) {
      entries = entries.filter((entry) => !matches(entry, identity));
      entries.push({
        threadId: identity.threadId,
        turnId: identity.turnId,
        itemId: identity.itemId,
        detail: previewChanges(changes),
      });
      if (entries.length > MAX_PENDING_ITEMS) entries.shift();
    },
    take(identity: ItemIdentity): string | undefined {
      const index = entries.findIndex((entry) => matches(entry, identity));
      return index === -1 ? undefined : entries.splice(index, 1)[0]?.detail;
    },
    discard(identity: {
      readonly threadId: string;
      readonly turnId?: string;
      readonly itemId?: string;
    }) {
      entries = entries.filter(
        (entry) =>
          entry.threadId !== identity.threadId ||
          (identity.turnId !== undefined && entry.turnId !== identity.turnId) ||
          (identity.itemId !== undefined && entry.itemId !== identity.itemId),
      );
    },
    clear() {
      entries = [];
    },
  };
}
