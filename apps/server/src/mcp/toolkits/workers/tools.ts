import {
  WorkerError,
  WorkerMcpApprovalResponseInput,
  WorkerMcpApprovalResponseResult,
  WorkerMcpCloseInput,
  WorkerMcpCloseResult,
  WorkerMcpGetInput,
  WorkerMcpGetResult,
  WorkerMcpInterruptInput,
  WorkerMcpInterruptResult,
  WorkerMcpListInput,
  WorkerMcpListResult,
  WorkerMcpObserveInput,
  WorkerMcpObserveResult,
  WorkerMcpSendInput,
  WorkerMcpSendResult,
  WorkerMcpStartInput,
  WorkerMcpStartResult,
  WorkerMcpWaitInput,
  WorkerMcpWaitResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerService from "../../../worker/WorkerService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, WorkerService.WorkerService];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutatingTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

export const WorkerStartTool = mutatingTool(
  Tool.make("worker_start", {
    description:
      "Start one persistent T3 Worker for a bounded assignment. The Worker does not inherit the parent conversation. State the task once in assignment; title is a label, and context and instructions should contain only non-duplicative supporting material. Do not ask it to report Worker IDs, token usage, or tool counts; T3 reports that server-owned telemetry through Worker tool results. Its runtime access mode inherits the parent session and cannot be overridden in this call. Omit modelSelection to inherit the parent's exact provider instance, model, and options. To change supported options such as reasoningEffort, send only modelSelection.options; do not guess instanceId or model aliases. Set backendPreference to codex-desktop when the assignment needs Codex Desktop's native browser or app capabilities; this preserves a separate native child identity and requires the configured Desktop coordinator. Exact native model slugs may be supplied with codex-desktop and are validated by the Desktop host.",
    parameters: WorkerMcpStartInput,
    success: WorkerMcpStartResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Start Worker"),
);

export const WorkerListTool = readonlyTool(
  Tool.make("worker_list", {
    description:
      "List Workers owned by this parent thread without contacting, waking, or interrupting them. Returns compact lifecycle, activity, usage, approval, unread, and resumability state.",
    parameters: WorkerMcpListInput,
    success: WorkerMcpListResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "List Workers"),
);

export const WorkerWaitTool = Tool.make("worker_wait", {
  description:
    "Wait once for a bounded interval and configured relevant events from selected Workers without polling or sending periodic messages. While this lease is active, do not call worker_status or worker_observe; if an interim event wakes the call and work continues, report useful progress and re-enter the same logical wait session. Results include T3-owned Worker identity, lifecycle, and usage; call worker_status after a wake when detailed tool activity is needed. An expired wait reports current state and does not mark a Worker failed or lost.",
  parameters: WorkerMcpWaitInput,
  success: WorkerMcpWaitResult,
  failure: WorkerError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for Workers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const WorkerStatusTool = readonlyTool(
  Tool.make("worker_status", {
    description:
      "Read persisted detail for one Worker owned by this parent, including lifecycle, usage, activations, messages, and detailed tool activity. This does not message the Worker, invoke an observer model, or change Worker state.",
    parameters: WorkerMcpGetInput,
    success: WorkerMcpGetResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Get Worker status"),
);

export const WorkerObserveTool = Tool.make("worker_observe", {
  description:
    "Create a read-only semantic progress report for one Worker owned by this parent. The observer cannot message or interrupt the target Worker or change repository files.",
  parameters: WorkerMcpObserveInput,
  success: WorkerMcpObserveResult,
  failure: WorkerError,
  dependencies,
})
  .annotate(Tool.Title, "Observe Worker")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const WorkerSendTool = mutatingTool(
  Tool.make("worker_send", {
    description:
      "Send a follow-up assignment with optional explicit context to a resumable Worker owned by this parent. A completed activation remains frozen and the follow-up starts a new activation.",
    parameters: WorkerMcpSendInput,
    success: WorkerMcpSendResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Send Worker follow-up"),
);

export const WorkerInterruptTool = mutatingTool(
  Tool.make("worker_interrupt", {
    description:
      "Interrupt the active assignment of a Worker owned by this parent without closing its persistent identity. Observe active work first unless force and a reason are explicit.",
    parameters: WorkerMcpInterruptInput,
    success: WorkerMcpInterruptResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Interrupt Worker"),
);

export const WorkerCloseTool = mutatingTool(
  Tool.make("worker_close", {
    description:
      "Explicitly close a Worker owned by this parent and release its provider resources. Closing is terminal for that Worker identity and is never implied by assignment completion.",
    parameters: WorkerMcpCloseInput,
    success: WorkerMcpCloseResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Close Worker"),
);

export const WorkerApprovalRespondTool = mutatingTool(
  Tool.make("worker_approval_respond", {
    description:
      "Respond to the pending approval request of a Worker owned by this parent. The response keeps the existing runtime and sandbox policy and cannot grant broader permissions.",
    parameters: WorkerMcpApprovalResponseInput,
    success: WorkerMcpApprovalResponseResult,
    failure: WorkerError,
    dependencies,
  }).annotate(Tool.Title, "Respond to Worker approval"),
);

export const WorkerToolkit = Toolkit.make(
  WorkerStartTool,
  WorkerListTool,
  WorkerWaitTool,
  WorkerStatusTool,
  WorkerObserveTool,
  WorkerSendTool,
  WorkerInterruptTool,
  WorkerCloseTool,
  WorkerApprovalRespondTool,
);
