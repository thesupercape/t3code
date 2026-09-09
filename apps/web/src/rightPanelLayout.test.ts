import { describe, expect, it } from "vite-plus/test";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "./rightPanelLayout";

describe("RIGHT_PANEL_SHEET_CLASS_NAME", () => {
  it("fills the phone viewport without retaining a desktop max width", () => {
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-sm:w-screen");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-sm:max-w-none");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-sm:min-w-0");
  });
});
