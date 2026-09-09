import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ComputerChromeNavigateInput,
  ComputerChromeSelectTabInput,
  ComputerChromeTargetInput,
  ComputerChromeValueInput,
  ComputerOpenUrlInput,
} from "./computerControl.ts";

const decode = Schema.decodeUnknownEffect(ComputerOpenUrlInput);
const decodeNavigate = Schema.decodeUnknownEffect(ComputerChromeNavigateInput);

it.effect("accepts long authentication URLs without restricting their domain", () =>
  Effect.gen(function* () {
    const url = `https://cfahome.okta.com/app/sso/saml?SAMLRequest=${"x".repeat(6_000)}`;
    expect(yield* decode({ url })).toEqual({ url });
  }),
);

it.effect("rejects non-web protocols", () =>
  Effect.gen(function* () {
    const error = yield* decode({ url: "file:///C:/Users/secret.txt" }).pipe(Effect.flip);
    expect(String(error)).toContain("http or https");
  }),
);

it.effect("allows managed Chrome to reset a tab to about:blank", () =>
  Effect.gen(function* () {
    expect(yield* decodeNavigate({ tabId: "tab-1", url: "about:blank" })).toEqual({
      tabId: "tab-1",
      url: "about:blank",
    });
  }),
);

it.effect("rejects unsafe and unintended navigation schemes", () =>
  Effect.gen(function* () {
    for (const url of ["about:srcdoc", "file:///C:/Users/secret.txt", "javascript:alert(1)"]) {
      const error = yield* decodeNavigate({ tabId: "tab-1", url }).pipe(Effect.flip);
      expect(String(error)).toContain("http or https");
    }
  }),
);

it("requires an explicit tab for every per-tab browser operation", () => {
  const inputs = [
    [ComputerChromeNavigateInput, { url: "https://example.test" }],
    [ComputerChromeSelectTabInput, {}],
    [ComputerChromeTargetInput, { target: { ref: "ref-1" } }],
    [ComputerChromeValueInput, { target: { selector: "#name" }, value: "Ada" }],
  ] as const;

  for (const [schema, input] of inputs) {
    expect(Schema.is(schema)(input)).toBe(false);
    expect(Schema.is(schema)({ ...input, tabId: "tab-1" })).toBe(true);
    expect(Schema.is(schema)({ ...input, tabId: " " })).toBe(false);
  }
});
