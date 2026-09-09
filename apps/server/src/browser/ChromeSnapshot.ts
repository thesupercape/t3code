/** The DOM shape used by the browser-side snapshot, without requiring DOM globals on the server. */
export interface SnapshotElement {
  readonly isConnected: boolean;
  readonly tagName: string;
  readonly parentElement: SnapshotElement | null;
  readonly previousElementSibling: SnapshotElement | null;
  readonly innerText?: string;
  readonly textContent: string | null;
  readonly getRootNode: () => { readonly host?: SnapshotElement };
  readonly getAttribute: (name: string) => string | null;
  readonly getBoundingClientRect: () => {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Serialized by Playwright into Chrome. Keep all runtime dependencies inside this function. */
export const collectSnapshotRefs = (elements: ReadonlyArray<unknown>) =>
  elements.map((entry, index) => {
    const element = entry as SnapshotElement;
    if (!element.isConnected)
      throw new Error("Snapshot element is detached. Take a fresh snapshot.");
    const segments: Array<string> = [];
    let ancestry: Array<string> = [];
    let ancestor: SnapshotElement | undefined | null = element;
    while (ancestor !== undefined && ancestor !== null) {
      let sameTagIndex = 1;
      let sibling = ancestor.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === ancestor.tagName) sameTagIndex += 1;
        sibling = sibling.previousElementSibling;
      }
      const tag = ancestor.tagName.toLowerCase().replace(/[^a-z0-9_-]/g, (c) => `\\${c}`);
      ancestry.unshift(`${tag}:nth-of-type(${sameTagIndex})`);
      if (ancestor.parentElement !== null) {
        ancestor = ancestor.parentElement;
      } else {
        segments.unshift(ancestry.join(" > "));
        ancestry = [];
        ancestor = ancestor.getRootNode().host;
      }
    }
    const rect = element.getBoundingClientRect();
    return {
      ref: `ref-${index + 1}`,
      selector: segments.join(" >> "),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name:
        element.getAttribute("aria-label") ??
        (element.innerText ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
