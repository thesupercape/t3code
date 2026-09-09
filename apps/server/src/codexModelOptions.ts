import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const serviceTier = getModelSelectionStringOptionValue(modelSelection, "serviceTier");
  if (serviceTier !== undefined) return serviceTier;
  const fastMode = getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
  return fastMode === undefined ? undefined : fastMode ? "fast" : "default";
}
