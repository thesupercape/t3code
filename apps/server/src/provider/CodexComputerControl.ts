import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

export const CODEX_COMPUTER_CONTROL_OPTION_ID = "computerControl";
// Keep persisted mode IDs readable. The legacy "desktop" mode grants the T3
// browser toolkit, not Codex desktop Computer Use or Windows input control.
export const CODEX_COMPUTER_CONTROL_MODES = ["preview", "chrome", "desktop"] as const;
export type CodexComputerControlMode = (typeof CODEX_COMPUTER_CONTROL_MODES)[number];
export const DEFAULT_CODEX_COMPUTER_CONTROL_MODE: CodexComputerControlMode = "chrome";

export function normalizeCodexComputerControlMode(
  value: string | null | undefined,
): CodexComputerControlMode {
  return CODEX_COMPUTER_CONTROL_MODES.includes(value as CodexComputerControlMode)
    ? (value as CodexComputerControlMode)
    : DEFAULT_CODEX_COMPUTER_CONTROL_MODE;
}

/** Whether this session receives T3's managed Chrome MCP toolkit. */
export const modelSelectionAllowsFullComputerControl = (
  selection: ModelSelection | undefined,
  providerDriverKind: ProviderDriverKind | undefined,
  boundInstanceId: ProviderInstanceId | undefined,
): boolean => {
  if (providerDriverKind !== "codex") return false;
  const selectedMode =
    selection !== undefined && selection.instanceId === boundInstanceId
      ? selection.options?.find((option) => option.id === CODEX_COMPUTER_CONTROL_OPTION_ID)?.value
      : undefined;
  const mode = normalizeCodexComputerControlMode(
    typeof selectedMode === "string" ? selectedMode : undefined,
  );
  return mode === "chrome" || mode === "desktop";
};
