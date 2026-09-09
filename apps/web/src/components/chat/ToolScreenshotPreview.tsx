import type { EnvironmentId, ToolScreenshot } from "@t3tools/contracts";
import { useState } from "react";
import { useAssetUrlState } from "../../assets/assetUrls";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function ToolScreenshotPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly screenshot: ToolScreenshot;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.screenshot.attachmentId,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const label = `Chrome screenshot, ${props.screenshot.width} × ${props.screenshot.height}`;
  if (asset._tag === "Failure" || (asset._tag === "Success" && failedUrl === asset.url)) {
    return (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        Screenshot unavailable
      </p>
    );
  }
  if (asset._tag !== "Success") {
    return (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        Loading screenshot…
      </p>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Expand ${label}`}
      className="mb-2 block max-w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => props.onImageExpand({ images: [{ src: asset.url, name: label }], index: 0 })}
    >
      <img
        src={asset.url}
        alt={label}
        width={props.screenshot.width}
        height={props.screenshot.height}
        className="h-auto max-h-80 max-w-full rounded-md border border-border/40 object-contain"
        loading="lazy"
        onError={() => setFailedUrl(asset.url)}
      />
    </button>
  );
}
