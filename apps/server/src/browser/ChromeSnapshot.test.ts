import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { collectSnapshotRefs, type SnapshotElement } from "./ChromeSnapshot.ts";

const element = (
  tagName: string,
  parentElement: SnapshotElement | null = null,
  previousElementSibling: SnapshotElement | null = null,
  attributes: Readonly<Record<string, string>> = {},
): SnapshotElement => ({
  isConnected: true,
  tagName,
  parentElement,
  previousElementSibling,
  textContent: "Example",
  getAttribute: (name) => attributes[name] ?? null,
  getRootNode: () => ({}),
  getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
});

it("serializes the actual browser callback without closing over server helpers", () => {
  const button = element("BUTTON", element("BODY"), null, { id: "submit:123" });
  const refs: ReturnType<typeof collectSnapshotRefs> = NodeVM.runInNewContext(
    `(${collectSnapshotRefs.toString()})(elements)`,
    { elements: [button] },
  );
  assert.equal(refs[0]?.selector, "body:nth-of-type(1) > button:nth-of-type(1)");
  assert.equal(refs[0]?.name, "Example");
});

it("distinguishes repeated controls under different parents and duplicate ids", () => {
  const body = element("BODY");
  const firstSection = element("SECTION", body);
  const secondSection = element("SECTION", body, firstSection);
  const first = element("BUTTON", firstSection, null, { id: "submit" });
  const second = element("BUTTON", secondSection, null, { id: "submit" });
  const refs = collectSnapshotRefs([first, second]);
  assert.equal(
    refs[0]?.selector,
    "body:nth-of-type(1) > section:nth-of-type(1) > button:nth-of-type(1)",
  );
  assert.equal(
    refs[1]?.selector,
    "body:nth-of-type(1) > section:nth-of-type(2) > button:nth-of-type(1)",
  );
});

it("keeps open shadow-root controls scoped to their host", () => {
  const host = element("CUSTOM-FORM", element("BODY"));
  const button = { ...element("BUTTON"), getRootNode: () => ({ host }) };
  assert.equal(
    collectSnapshotRefs([button])[0]?.selector,
    "body:nth-of-type(1) > custom-form:nth-of-type(1) >> button:nth-of-type(1)",
  );
});

it("reads accessible names from SVG controls without requiring innerText", () => {
  const icon = element("svg", null, null, { role: "button", "aria-label": "Close" });
  assert.equal(collectSnapshotRefs([icon])[0]?.name, "Close");
});
