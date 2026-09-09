import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ status: "Success", resources: [] as unknown[] }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    state.resources.push({ environmentId, resource });
    return state.status === "Success"
      ? { _tag: "Success", url: "https://remote.test/api/assets/signed/screenshot.png" }
      : { _tag: state.status };
  },
}));
import { ToolScreenshotPreview } from "./ToolScreenshotPreview";

const screenshot = {
  threadId: ThreadId.make("thread-1"),
  attachmentId: "thread-1-12345678-1234-1234-1234-123456789abc",
  mimeType: "image/png" as const,
  width: 1280,
  height: 720,
};
const render = () =>
  renderToStaticMarkup(
    <ToolScreenshotPreview
      environmentId={EnvironmentId.make("remote")}
      screenshot={screenshot}
      onImageExpand={() => undefined}
    />,
  );
beforeEach(() => {
  state.status = "Success";
  state.resources = [];
});
it("renders a bounded image through the environment's signed attachment URL", () => {
  const html = render();
  expect(state.resources).toEqual([
    {
      environmentId: "remote",
      resource: { _tag: "attachment", attachmentId: screenshot.attachmentId },
    },
  ]);
  expect(html).toContain('src="https://remote.test/api/assets/signed/screenshot.png"');
  expect(html).toContain('alt="Chrome screenshot, 1280 × 720"');
  expect(html).toContain('aria-label="Expand Chrome screenshot, 1280 × 720"');
  expect(html).toContain("max-w-full");
  expect(html).toContain('loading="lazy"');
});
it.each(["Loading", "Failure"])(
  "renders an explicit %s state without an image request",
  (status) => {
    state.status = status;
    const html = render();
    expect(html).toContain(status === "Loading" ? "Loading screenshot" : "Screenshot unavailable");
    expect(html).not.toContain("<img");
  },
);
