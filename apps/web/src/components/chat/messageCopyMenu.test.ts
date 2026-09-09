import { describe, expect, it } from "vite-plus/test";
import timelineSource from "./MessagesTimeline.tsx?raw";

import {
  MESSAGE_COPY_MENU_ITEMS,
  messageCopyMenuShouldYield,
  messageCopyPointerMoved,
  messagePlainText,
} from "./messageCopyMenu";

describe("message copy menu", () => {
  it("offers raw Markdown and rendered plain text", () => {
    expect(MESSAGE_COPY_MENU_ITEMS.map((item) => item.id)).toEqual([
      "copy-markdown",
      "copy-plain-text",
    ]);
  });

  it("keeps assistant copy reachable on coarse pointers", () => {
    expect(timelineSource).toContain(
      "group-hover/assistant:opacity-100 pointer-coarse:opacity-100",
    );
  });

  it("leaves nested links and controls in charge of their own long press", () => {
    const nestedLink = { closest: () => ({}) } as unknown as EventTarget;
    const messageBody = { closest: () => null } as unknown as EventTarget;
    expect(messageCopyMenuShouldYield(nestedLink, false)).toBe(true);
    expect(messageCopyMenuShouldYield(messageBody, true)).toBe(true);
    expect(messageCopyMenuShouldYield(messageBody, false)).toBe(false);
  });

  it("cancels a long press after touch movement", () => {
    expect(messageCopyPointerMoved({ x: 10, y: 10 }, { x: 16, y: 16 })).toBe(false);
    expect(messageCopyPointerMoved({ x: 10, y: 10 }, { x: 22, y: 10 })).toBe(true);
  });

  it("copies rendered text with a source fallback", () => {
    const message = { innerText: "Rendered response", textContent: "" } as HTMLElement;
    expect(messagePlainText(message, "**source**")).toBe("Rendered response");
    expect(messagePlainText(null, "**source**")).toBe("**source**");
  });
});
