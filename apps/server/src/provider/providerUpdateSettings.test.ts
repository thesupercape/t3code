import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettings,
} from "./providerUpdateSettings.ts";

describe("provider snapshot settings", () => {
  it("refreshes browser choices when Preview access changes", () => {
    const enabled = makeProviderSnapshotSettings(
      {},
      { ...DEFAULT_UNIFIED_SETTINGS, enableAgentBrowserAccess: true },
    );
    const disabled = makeProviderSnapshotSettings(
      {},
      { ...DEFAULT_UNIFIED_SETTINGS, enableAgentBrowserAccess: false },
    );
    expect(haveProviderSnapshotSettingsChanged(enabled, disabled)).toBe(true);
    expect(haveProviderSnapshotSettingsChanged(disabled, enabled)).toBe(true);
  });

  it("does not refresh for unchanged browser availability settings", () => {
    const previous = makeProviderSnapshotSettings({}, DEFAULT_UNIFIED_SETTINGS);
    const next = makeProviderSnapshotSettings({}, DEFAULT_UNIFIED_SETTINGS);
    expect(haveProviderSnapshotSettingsChanged(previous, next)).toBe(false);
  });
});
