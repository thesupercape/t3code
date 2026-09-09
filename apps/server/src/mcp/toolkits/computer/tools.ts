import {
  ComputerChromeActionResult,
  ComputerChromeAutomationError,
  ComputerChromeEmptyInput,
  ComputerChromeNavigateInput,
  ComputerChromeSelectTabInput,
  ComputerChromeSnapshot,
  ComputerChromeSnapshotInput,
  ComputerChromeScreenshot,
  ComputerChromeStatus,
  ComputerChromeTab,
  ComputerChromeTargetInput,
  ComputerChromeValueInput,
  ComputerControlUnavailableError,
  ComputerOpenUrlInput,
  ComputerOpenUrlFailedError,
  ComputerOpenUrlResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { Schema } from "effect";
import { McpSchema, Tool, Toolkit } from "effect/unstable/ai";

import * as ChromeAutomation from "../../../browser/ChromeAutomation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";

const chromeDependencies = [
  McpInvocationContext.McpInvocationContext,
  ChromeAutomation.ChromeAutomation,
];

const chromeFailure = Schema.Union([
  ComputerControlUnavailableError,
  ComputerChromeAutomationError,
]);

const readOnlyChromeTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutatingChromeTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

const safeChromeTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, false) as T;

const idempotentChromeTool = <T extends Tool.Any>(tool: T): T =>
  safeChromeTool(tool).annotate(Tool.Idempotent, true) as T;

/**
 * MCP's tool-list filter runs inside the authenticated request fiber. Keep
 * computer control out of catalogs unless that fiber carries the same
 * capability used by the execution-time guard.
 */
export const hasCurrentComputerCapability = (): boolean => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return invocation._tag === "Some" && invocation.value.capabilities.has("computer");
};

const computerTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, hasCurrentComputerCapability) as T;

export const ComputerStartTool = computerTool(
  idempotentChromeTool(
    Tool.make("computer_start", {
      description:
        "Start T3's persistent, user-visible Chrome session and select its first tab. This is idempotent and does not create a new profile.",
      parameters: ComputerChromeEmptyInput,
      success: ComputerChromeStatus,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    }).annotate(Tool.Title, "Start T3 Chrome"),
  ),
);

export const ComputerStatusTool = computerTool(
  readOnlyChromeTool(
    Tool.make("computer_status", {
      description: "Report the lifecycle and selected-tab state of T3's managed Chrome session.",
      parameters: ComputerChromeEmptyInput,
      success: ComputerChromeStatus,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    }).annotate(Tool.Title, "Get T3 Chrome status"),
  ),
);

export const ComputerTabsTool = computerTool(
  readOnlyChromeTool(
    Tool.make("computer_tabs", {
      description:
        "List the readable IDs, URLs, titles, and selection state of managed Chrome tabs.",
      parameters: ComputerChromeEmptyInput,
      success: Schema.Array(ComputerChromeTab),
      failure: chromeFailure,
      dependencies: chromeDependencies,
    }).annotate(Tool.Title, "List T3 Chrome tabs"),
  ),
);

export const ComputerSelectTabTool = computerTool(
  idempotentChromeTool(
    Tool.make("computer_select_tab", {
      description: "Select one managed Chrome tab by its ID for subsequent navigation and actions.",
      parameters: ComputerChromeSelectTabInput,
      success: ComputerChromeTab,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    }).annotate(Tool.Title, "Select T3 Chrome tab"),
  ),
);

export const ComputerNavigateTool = computerTool(
  safeChromeTool(
    Tool.make("computer_navigate", {
      description:
        "Navigate the specified managed Chrome tab to an exact absolute HTTP or HTTPS URL, or reset it with exactly about:blank. Obtain tabId from computer_tabs; actions do not follow another agent's tab selection.",
      parameters: ComputerChromeNavigateInput,
      success: ComputerChromeTab,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Navigate T3 Chrome")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerSnapshotTool = computerTool(
  readOnlyChromeTool(
    Tool.make("computer_snapshot", {
      description:
        "Inspect the specified managed Chrome tab and return a compact accessibility tree and fresh interaction refs. Obtain tabId from computer_tabs. Refs belong to this tab and snapshot. Set includeDom only when the accessibility view is insufficient because full DOM output is expensive.",
      parameters: ComputerChromeSnapshotInput,
      success: ComputerChromeSnapshot,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Snapshot T3 Chrome")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerClickTool = computerTool(
  mutatingChromeTool(
    Tool.make("computer_click", {
      description:
        "Click one ref from the latest snapshot or one explicit CSS selector in the specified tab. Use the tabId returned by computer_tabs or computer_snapshot.",
      parameters: ComputerChromeTargetInput,
      success: ComputerChromeActionResult,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Click T3 Chrome")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerScreenshotTool = computerTool(
  readOnlyChromeTool(
    Tool.make("computer_screenshot", {
      description:
        "Capture a PNG of the specified managed Chrome tab's viewport. Obtain tabId from computer_tabs. The viewport must be at most 4096 pixels per dimension; output is limited to 5 MiB.",
      parameters: ComputerChromeSelectTabInput,
      success: ComputerChromeScreenshot,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Screenshot T3 Chrome")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerFillTool = computerTool(
  mutatingChromeTool(
    Tool.make("computer_fill", {
      description:
        "Replace the value of one snapshot ref or explicit CSS selector with literal text in the specified tab. Use the tabId returned by computer_tabs or computer_snapshot.",
      parameters: ComputerChromeValueInput,
      success: ComputerChromeActionResult,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Fill T3 Chrome field")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerTypeTool = computerTool(
  mutatingChromeTool(
    Tool.make("computer_type", {
      description:
        "Type literal text into one snapshot ref or explicit CSS selector in the specified tab. Use the tabId returned by computer_tabs or computer_snapshot.",
      parameters: ComputerChromeValueInput,
      success: ComputerChromeActionResult,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    })
      .annotate(Tool.Title, "Type in T3 Chrome")
      .annotate(Tool.OpenWorld, true),
  ),
);

export const ComputerCloseTool = computerTool(
  mutatingChromeTool(
    Tool.make("computer_close", {
      description: "Close T3's managed Chrome session and release its browser process.",
      parameters: ComputerChromeEmptyInput,
      success: ComputerChromeStatus,
      failure: chromeFailure,
      dependencies: chromeDependencies,
    }).annotate(Tool.Title, "Close T3 Chrome"),
  ),
);

export const ComputerOpenUrlTool = computerTool(
  Tool.make("computer_open_url", {
    description:
      "Open an exact absolute HTTP or HTTPS URL in the user's Google Chrome session. Use this when the Chrome extension is unavailable or Windows Computer Use cannot reliably focus the address bar. This tool has no domain allowlist and supports long authentication or relay URLs. It only navigates; continue with Chrome or Windows Computer Use to inspect and interact with the page.",
    parameters: ComputerOpenUrlInput,
    success: ComputerOpenUrlResult,
    failure: Schema.Union([ComputerControlUnavailableError, ComputerOpenUrlFailedError]),
    dependencies: [McpInvocationContext.McpInvocationContext, ExternalLauncher.ExternalLauncher],
  })
    .annotate(Tool.Title, "Open URL in Google Chrome")
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false),
);

export const ComputerToolkit = Toolkit.make(
  ComputerStartTool,
  ComputerStatusTool,
  ComputerTabsTool,
  ComputerSelectTabTool,
  ComputerNavigateTool,
  ComputerSnapshotTool,
  ComputerScreenshotTool,
  ComputerClickTool,
  ComputerFillTool,
  ComputerTypeTool,
  ComputerCloseTool,
  ComputerOpenUrlTool,
);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStartTool,
  ComputerStatusTool,
  ComputerTabsTool,
  ComputerSelectTabTool,
  ComputerNavigateTool,
  ComputerSnapshotTool,
  ComputerClickTool,
  ComputerFillTool,
  ComputerTypeTool,
  ComputerCloseTool,
  ComputerOpenUrlTool,
);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
