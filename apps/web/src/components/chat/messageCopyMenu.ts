export const MESSAGE_COPY_LONG_PRESS_MS = 500;
export const MESSAGE_COPY_MOVE_TOLERANCE_PX = 10;

export const MESSAGE_COPY_MENU_ITEMS = [
  { id: "copy-markdown", label: "Copy Markdown", icon: "copy" },
  { id: "copy-plain-text", label: "Copy plain text", icon: "copy" },
] as const;

export type MessageCopyMenuChoice = (typeof MESSAGE_COPY_MENU_ITEMS)[number]["id"];

export function messageCopyMenuShouldYield(target: EventTarget | null, defaultPrevented: boolean) {
  if (defaultPrevented) return true;
  if (!target || typeof (target as Element).closest !== "function") return false;
  return (
    (target as Element).closest(
      "a, button, input, textarea, select, [role='button'], [role='menuitem'], [data-message-copy-menu-ignore]",
    ) !== null
  );
}

export function messageCopyPointerMoved(
  start: { x: number; y: number },
  current: { x: number; y: number },
) {
  return Math.hypot(current.x - start.x, current.y - start.y) > MESSAGE_COPY_MOVE_TOLERANCE_PX;
}

export function messagePlainText(element: HTMLElement | null, fallback: string) {
  const text = element?.innerText || element?.textContent || fallback;
  return text.trim();
}
