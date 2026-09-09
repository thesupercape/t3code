import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  getSubagentBackendOptions,
  getSubagentBackendUnavailableReason,
  resolveComposerSubagentBackend,
} from "./providerModels";

const CODEX = ProviderDriverKind.make("codex");

describe("getSubagentBackendOptions", () => {
  it("leaves a fresh Codex task on no sub-agent backend while Workers are disabled", () => {
    expect(resolveComposerSubagentBackend(null, CODEX, { workersEnabled: false })).toBeNull();
  });

  it("defaults a fresh Codex task to Native V1 control when Workers are enabled", () => {
    expect(resolveComposerSubagentBackend(undefined, CODEX, { workersEnabled: true })).toBe(
      "native-v1-control",
    );
  });

  it("preserves explicit V1 and V2 task selections", () => {
    expect(resolveComposerSubagentBackend("v1", CODEX, { workersEnabled: false })).toBe("v1");
    expect(resolveComposerSubagentBackend("v2", CODEX, { workersEnabled: false })).toBe("v2");
  });

  it("does not carry a Codex backend into another provider", () => {
    expect(
      resolveComposerSubagentBackend("native-v1-control", ProviderDriverKind.make("claude"), {
        workersEnabled: true,
      }),
    ).toBeNull();
  });

  it("fails closed when the selected model does not advertise a backend", () => {
    const options = getSubagentBackendOptions(
      [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ],
      "gpt-5.6-sol",
      CODEX,
    );

    expect(options.map((option) => option.supported)).toEqual([false, false, false]);
    expect(options.map((option) => option.reason.length > 0)).toEqual([true, true, true]);
  });

  it("exposes the exact three choices and preserves provider capability reasons", () => {
    const options = getSubagentBackendOptions(
      [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [],
            subagentBackends: {
              v1: { supported: false, reason: "V1 unavailable" },
              v2: { supported: true },
              "native-v1-control": { supported: false, reason: "Native control unavailable" },
            },
          }),
        },
      ],
      "gpt-5.6-sol",
      CODEX,
    );

    expect(options.map((option) => option.label)).toEqual(["V1", "V2", "Native V1 control"]);
    expect(options.map((option) => option.supported)).toEqual([false, true, false]);
    expect(options[0]?.reason).toBe("V1 unavailable");
  });

  it("clears a saved Native selection when Workers are disabled", () => {
    const models = [
      {
        slug: "gpt-test",
        name: "GPT Test",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [],
          subagentBackends: {
            v1: { supported: true },
            v2: { supported: false, reason: "V2 unavailable" },
            "native-v1-control": { supported: true },
          },
        }),
      },
    ];

    const defaultBackend = resolveComposerSubagentBackend("native-v1-control", CODEX, {
      workersEnabled: false,
    });
    expect(defaultBackend).toBeNull();
    expect(
      getSubagentBackendOptions(models, "gpt-test", CODEX, { workersEnabled: false }).map(
        (option) => option.supported,
      ),
    ).toEqual([true, false, false]);
    expect(
      getSubagentBackendUnavailableReason(defaultBackend, models, "gpt-test", CODEX),
    ).toBeNull();
  });
});
