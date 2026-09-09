import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SidebarThreadOverflowButton,
  threadOverflowMenuPosition,
} from "./SidebarThreadOverflowButton";

describe("SidebarThreadOverflowButton", () => {
  it("uses a coarse-pointer-only 44px action target", () => {
    const html = renderToStaticMarkup(
      <SidebarThreadOverflowButton threadTitle="Mobile work" onOpen={() => {}} />,
    );

    expect(html).toContain("size-11");
    expect(html).toContain("pointer-fine:hidden");
    expect(html).toContain('aria-label="More actions for Mobile work"');
  });

  it("opens the existing menu below the center of the action", () => {
    expect(threadOverflowMenuPosition({ bottom: 80, left: 240, width: 44 })).toEqual({
      x: 262,
      y: 80,
    });
  });
});
