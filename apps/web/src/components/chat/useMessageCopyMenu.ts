import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import {
  MESSAGE_COPY_LONG_PRESS_MS,
  MESSAGE_COPY_MENU_ITEMS,
  messageCopyMenuShouldYield,
  messageCopyPointerMoved,
  messagePlainText,
} from "./messageCopyMenu";

export function useMessageCopyMenu(
  markdownText: string,
  contentRef: RefObject<HTMLElement | null>,
) {
  const { copyToClipboard } = useCopyToClipboard({ target: "message" });
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressOpenedAtRef = useRef(0);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  const openCopyMenu = useCallback(
    (position: { x: number; y: number }, openedByLongPress: boolean) => {
      cancelLongPress();
      if (openedByLongPress) longPressOpenedAtRef.current = Date.now();
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show(MESSAGE_COPY_MENU_ITEMS, position)
        .then((choice) => {
          if (choice === "copy-markdown") {
            copyToClipboard(markdownText);
          } else if (choice === "copy-plain-text") {
            copyToClipboard(messagePlainText(contentRef.current, markdownText));
          }
        })
        .catch((error) => console.error("Could not open message copy menu.", error));
    },
    [cancelLongPress, contentRef, copyToClipboard, markdownText],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (
        event.pointerType === "mouse" ||
        messageCopyMenuShouldYield(event.target, event.defaultPrevented)
      ) {
        return;
      }
      cancelLongPress();
      const start = { x: event.clientX, y: event.clientY };
      longPressStartRef.current = start;
      longPressTimerRef.current = window.setTimeout(() => {
        openCopyMenu(start, true);
      }, MESSAGE_COPY_LONG_PRESS_MS);
    },
    [cancelLongPress, openCopyMenu],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = longPressStartRef.current;
      if (start && messageCopyPointerMoved(start, { x: event.clientX, y: event.clientY })) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (messageCopyMenuShouldYield(event.target, event.defaultPrevented)) return;
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() - longPressOpenedAtRef.current < 1_000) return;
      openCopyMenu({ x: event.clientX, y: event.clientY }, false);
    },
    [openCopyMenu],
  );

  return {
    onContextMenu,
    onPointerCancel: cancelLongPress,
    onPointerDown,
    onPointerLeave: cancelLongPress,
    onPointerMove,
    onPointerUp: cancelLongPress,
  };
}
