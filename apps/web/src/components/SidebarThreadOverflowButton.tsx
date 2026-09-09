import { MoreHorizontalIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";

export function threadOverflowMenuPosition(rect: Pick<DOMRect, "bottom" | "left" | "width">) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.bottom,
  };
}

export const SidebarThreadOverflowButton = memo(function SidebarThreadOverflowButton(props: {
  threadTitle: string;
  onOpen: (position: { x: number; y: number }) => void;
}) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    props.onOpen(threadOverflowMenuPosition(event.currentTarget.getBoundingClientRect()));
  };

  return (
    <button
      type="button"
      aria-label={`More actions for ${props.threadTitle}`}
      className="absolute right-0 top-1/2 z-20 flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:hidden"
      onClick={handleClick}
    >
      <MoreHorizontalIcon aria-hidden className="size-4" />
    </button>
  );
});
