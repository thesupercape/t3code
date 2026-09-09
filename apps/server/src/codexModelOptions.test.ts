import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});

it("explicitly restores standard service when legacy Fast Mode is switched off", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", [
    { id: "fastMode", value: false },
  ]);
  assert.equal(getCodexServiceTierOptionValue(selection), "default");
});

it("preserves an unspecified tier and gives the explicit service tier precedence", () => {
  assert.equal(getCodexServiceTierOptionValue(undefined), undefined);
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", [
    { id: "serviceTier", value: "priority" },
    { id: "fastMode", value: false },
  ]);
  assert.equal(getCodexServiceTierOptionValue(selection), "priority");
});
