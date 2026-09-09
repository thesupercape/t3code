import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerImagePicker, takeComposerImageFiles } from "./ComposerImagePicker";

describe("ComposerImagePicker", () => {
  it("renders a multiple native image picker", () => {
    const html = renderToStaticMarkup(
      <ComposerImagePicker busy={false} disabled={false} onFiles={() => {}} />,
    );

    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("multiple");
    expect(html).toContain('aria-label="Attach images"');
  });

  it("clears the native input after selection so the same file can be picked again", () => {
    const image = new File(["image"], "photo.png", { type: "image/png" });
    const input = { files: [image], value: "C:\\fakepath\\photo.png" };

    const files = takeComposerImageFiles(input);

    expect(files).toEqual([image]);
    expect(input.value).toBe("");
  });

  it("announces image preparation and blocks another picker", () => {
    const html = renderToStaticMarkup(
      <ComposerImagePicker busy disabled={false} onFiles={() => {}} />,
    );

    expect(html).toContain('aria-label="Preparing images"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("Preparing selected images");
  });
});
