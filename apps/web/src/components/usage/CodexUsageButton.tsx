import { useEffect, useRef, type ReactNode } from "react";

/** Owns the hold gesture without blocking the Usage page's scroll container. */
export function CodexUsageButton({
  children,
  onOpen,
}: {
  readonly children: ReactNode;
  readonly onOpen: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label="Open Codex usage and resets"
      className="inline-flex min-h-11 min-w-11 shrink-0 touch-pan-y touch-pinch-zoom select-none items-center gap-2 rounded-md text-sm hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-ring active:bg-accent"
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
      onPointerDown={(event) => {
        cancel();
        suppressClick.current = false;
        if (!event.isPrimary || event.button !== 0) return;
        start.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          cancel();
          suppressClick.current = true;
          onOpen();
        }, 550);
      }}
      onPointerMove={(event) => {
        if (
          start.current &&
          Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10
        ) {
          cancel();
          suppressClick.current = true;
        }
      }}
      onPointerUp={cancel}
      onPointerCancel={() => {
        cancel();
        suppressClick.current = true;
      }}
      onPointerLeave={() => {
        cancel();
        suppressClick.current = true;
      }}
      onBlur={cancel}
      onKeyDown={() => {
        cancel();
        suppressClick.current = false;
      }}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (!suppressClick.current) onOpen();
        suppressClick.current = false;
      }}
    >
      {children}
    </button>
  );
}
