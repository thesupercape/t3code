import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import { ComputerToolkit } from "../../mcp/toolkits/computer/tools.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { normalizeCodexComputerControlMode } from "../CodexComputerControl.ts";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeModelListResponse = Schema.decodeUnknownSync(CodexSchema.V2ModelListResponse);
const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

const CODEX_0_148_MODEL_LIST_SANITIZED = {
  data: [
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      ],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      multiAgentVersion: "v2",
      additionalSpeedTiers: ["fast"],
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      defaultServiceTier: null,
      isDefault: true,
    },
    {
      id: "gpt-5.4",
      model: "gpt-5.4",
      upgrade: "gpt-5.6-terra",
      upgradeInfo: {
        model: "gpt-5.6-terra",
        upgradeCopy: null,
        modelLink: null,
        migrationMarkdown: "GPT-5.4 will be deprecated soon.",
        retirementAt: 1_788_202_800,
      },
      availabilityNux: null,
      displayName: "GPT-5.4",
      description: "Strong model for everyday coding.",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
      ],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      supportsPersonality: true,
      multiAgentVersion: null,
      additionalSpeedTiers: ["fast"],
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      defaultServiceTier: null,
      isDefault: false,
    },
  ],
  nextCursor: null,
} as const;

it("decodes the sanitized Codex 0.148.0 model/list payload and fails closed for null capability", () => {
  const decoded = decodeModelListResponse(CODEX_0_148_MODEL_LIST_SANITIZED);
  const v2Capabilities = mapCodexModelCapabilities(decoded.data[0]!);
  const nullCapabilities = mapCodexModelCapabilities(decoded.data[1]!);

  assert.equal(v2Capabilities.subagentBackends?.v2.supported, true);
  assert.equal(v2Capabilities.subagentBackends?.v1.supported, false);
  assert.equal(nullCapabilities.subagentBackends?.v1.supported, false);
  assert.equal(nullCapabilities.subagentBackends?.v2.supported, false);
  assert.equal(
    nullCapabilities.subagentBackends?.v1.reason,
    "The live Codex model catalog reported no multi-agent runtime for this model.",
  );
});

it("decodes an unknown future multi-agent version and fails closed with an explicit reason", () => {
  const decoded = decodeModelListResponse({
    data: [
      {
        ...CODEX_0_148_MODEL_LIST_SANITIZED.data[0],
        id: "future-model",
        model: "future-model",
        multiAgentVersion: "v3-preview",
      },
    ],
    nextCursor: null,
  });
  const capabilities = mapCodexModelCapabilities(decoded.data[0]!);

  assert.equal(capabilities.subagentBackends?.v1.supported, false);
  assert.equal(capabilities.subagentBackends?.v2.supported, false);
  assert.match(
    capabilities.subagentBackends?.v1.reason ?? "",
    /unrecognized multi-agent version 'v3-preview'/,
  );
});

it("keeps only the GPT-5.6 Codex family out of legacy models", () => {
  assert.deepStrictEqual(
    [
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-daybreak-blue-latest",
      "gpt-daybreak-red-latest",
      "gpt-5.4",
    ].map((model) => [model, isLegacyCodexModel(model)]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-daybreak-blue-latest", false],
      ["gpt-daybreak-red-latest", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("maps sub-agent backends from the live model multiAgentVersion field", () => {
  const v1 = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "V1 model",
    displayName: "V1 model",
    hidden: false,
    id: "v1-model",
    isDefault: true,
    model: "v1-model",
    multiAgentVersion: "v1",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [],
  });
  const v2 = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "V2 model",
    displayName: "V2 model",
    hidden: false,
    id: "v2-model",
    isDefault: false,
    model: "v2-model",
    multiAgentVersion: "v2",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [],
  });
  const missing = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "Missing capability",
    displayName: "Missing capability",
    hidden: false,
    id: "missing-capability",
    isDefault: false,
    model: "missing-capability",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [],
  });
  const disabled = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "Disabled",
    displayName: "Disabled",
    hidden: false,
    id: "disabled",
    isDefault: false,
    model: "disabled",
    multiAgentVersion: "disabled",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(
    [v1, v2, missing, disabled].map((capabilities) => [
      capabilities.subagentBackends?.v1.supported,
      capabilities.subagentBackends?.v2.supported,
      capabilities.subagentBackends?.["native-v1-control"].supported,
    ]),
    [
      [true, false, true],
      [false, true, true],
      [false, false, true],
      [false, false, true],
    ],
  );
  assert.ok(missing.subagentBackends?.v1.reason);
  assert.ok(missing.subagentBackends?.v2.reason);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("offers only provisionable T3 browser routes with a valid default", () => {
  const model = decodeModelListResponse(CODEX_0_148_MODEL_LIST_SANITIZED).data[0]!;
  const cases = [
    { tools: {}, ids: [], currentValue: undefined },
    { tools: { computer_open_url: {} }, ids: [], currentValue: undefined },
    { tools: ComputerToolkit.tools, ids: ["chrome"], currentValue: "chrome" },
    { tools: PreviewToolkit.tools, ids: ["preview"], currentValue: "preview" },
    {
      tools: { ...ComputerToolkit.tools, ...PreviewToolkit.tools },
      ids: ["chrome", "preview"],
      currentValue: "chrome",
    },
  ];
  for (const { tools, ids, currentValue } of cases) {
    const capabilities = mapCodexModelCapabilities(model, [{ name: "t3-code", tools }]);
    const descriptor = capabilities.optionDescriptors?.find(
      (option) => option.id === "computerControl",
    );
    assert.deepStrictEqual(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
      ids,
    );
    assert.equal(descriptor?.currentValue, currentValue);
    if (descriptor?.type === "select") {
      assert.equal(descriptor.options.find((option) => option.isDefault)?.id, currentValue);
    }
  }
});

it("does not offer host-specific routes based only on JavaScript or plugin tool names", () => {
  const model = decodeModelListResponse(CODEX_0_148_MODEL_LIST_SANITIZED).data[0]!;
  const capabilities = mapCodexModelCapabilities(model, [
    { name: "node_repl", tools: { js: {} } },
    { name: "chrome", tools: ComputerToolkit.tools },
    { name: "computer-use", tools: ComputerToolkit.tools },
  ]);
  assert.equal(
    capabilities.optionDescriptors?.some((option) => option.id === "computerControl"),
    false,
  );
});

it("retains saved desktop compatibility without offering it as a new provider", () => {
  const model = decodeModelListResponse(CODEX_0_148_MODEL_LIST_SANITIZED).data[0]!;
  const caps = mapCodexModelCapabilities(model, [
    { name: "t3-code", tools: ComputerToolkit.tools },
  ]);
  const descriptor = getProviderOptionDescriptors({
    caps,
    selections: [{ id: "computerControl", value: "desktop" }],
  }).find((option) => option.id === "computerControl");
  assert.equal(normalizeCodexComputerControlMode("desktop"), "desktop");
  assert.equal(normalizeCodexComputerControlMode(undefined), "chrome");
  assert.equal(descriptor?.currentValue, "chrome");
});

it.effect("passes detected browser readiness through the provider catalog probe", () =>
  Effect.gen(function* () {
    const tools = [{ name: "t3-code", tools: PreviewToolkit.tools }];
    let observedTools: unknown;
    yield* checkCodexProviderStatus(
      defaultCodexSettings,
      (input) => {
        observedTools = input.browserTools;
        return Effect.succeed({
          account: { account: null, requiresOpenaiAuth: false },
          version: undefined,
          models: [],
          skills: [],
        });
      },
      {},
      tools,
    );
    assert.deepStrictEqual(observedTools, tools);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
