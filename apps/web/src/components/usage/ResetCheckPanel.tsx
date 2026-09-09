import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResetCheckState } from "@t3tools/contracts";
import {
  latestResetCheck,
  resetCheckPresentation,
} from "@t3tools/client-runtime/resetCheckPresentation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { Clock3Icon, CheckCircle2Icon, AlertCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function ResetCheckPanel({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const queryAtom = serverEnvironment.resetCheck({ environmentId, input: {} });
  const query = useAtomValue(queryAtom);
  const start = useAtomCommand(serverEnvironment.startResetCheck, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelResetCheck, { reportFailure: false });
  const [command, setCommand] = useState<ResetCheckState | null>(null);
  const active = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = latestResetCheck(Option.getOrNull(AsyncResult.value(query)), command);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => appAtomRegistry.refresh(queryAtom), 3_000);
    return () => window.clearInterval(timer);
  }, [queryAtom, running]);
  const act = async (action: typeof start) => {
    if (active.current) return;
    active.current = true;
    setSending(true);
    setError(null);
    try {
      const reply = await action({ environmentId, input: {} });
      if (reply._tag === "Success") setCommand(reply.value);
      else
        setError(
          "Could not reach the reset checker. Reconnect or update this computer's T3 server.",
        );
      appAtomRegistry.refresh(queryAtom);
    } catch {
      setError("Could not reach the reset checker. Reconnect and try again.");
    } finally {
      active.current = false;
      setSending(false);
    }
  };
  const presentation = resetCheckPresentation(state);
  return (
    <ResetCheckResult
      state={state}
      presentation={presentation}
      label={label}
      sending={sending}
      unavailable={query._tag === "Failure"}
      error={error}
      onStart={() => void act(start)}
      onCancel={() => void act(cancel)}
    />
  );
}

export function ResetCheckResult({
  state,
  presentation,
  label,
  sending,
  unavailable,
  error,
  onStart,
  onCancel,
}: {
  state: ResetCheckState | null;
  presentation: ReturnType<typeof resetCheckPresentation>;
  label: string;
  sending: boolean;
  unavailable: boolean;
  error: string | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  const running = state?.status === "running";
  const finding = state?.result;
  const Icon =
    running || sending
      ? Clock3Icon
      : state?.status === "completed"
        ? CheckCircle2Icon
        : AlertCircleIcon;
  return (
    <section
      aria-label="Luna reset check"
      className="mt-4 rounded-lg border border-border bg-card/20 p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-h-11 items-center gap-2 text-sm" role="status" aria-live="polite">
          {(state && state.status !== "idle") || sending ? (
            <Icon
              aria-hidden
              className={`size-4 shrink-0 ${running ? "text-amber-500" : "text-muted-foreground"}`}
            />
          ) : null}
          <span>
            {running
              ? "Luna is checking X…"
              : sending
                ? "Contacting Luna…"
                : "Check Tibo's latest posts"}
          </span>
        </div>
        {running ? (
          <Button variant="outline" className="min-h-11" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={sending || unavailable || state === null}
            onClick={onStart}
          >
            Check X with Luna
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Runs on {label}. Uses Codex allowance. Only checks when you press the button.
      </p>
      <a
        href="https://x.com/thsottiaux/with_replies"
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-9 items-center text-xs text-muted-foreground underline underline-offset-4"
      >
        Open Tibo's posts and replies
      </a>
      {unavailable || error ? (
        <p role="alert" className="mt-3 text-sm">
          {error ?? "Reset checker unavailable. Reconnect or update this computer's T3 server."}
        </p>
      ) : null}
      {state?.status === "failed" ? (
        <p role="alert" className="mt-3 text-sm">
          {state.error}
        </p>
      ) : null}
      {state?.status === "cancelled" ? (
        <p role="status" className="mt-3 text-sm">
          Check cancelled. No reset time was changed.
        </p>
      ) : null}
      {finding ? (
        <div className="mt-4 space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Search completed · {finding.sources.length} sources
          </p>
          <p className="font-medium">{presentation.title}</p>
          <p className="text-muted-foreground">{finding.summary}</p>
          {presentation.range ? (
            <p className="text-base tabular-nums">{presentation.range}</p>
          ) : null}
          {presentation.likely && finding.earliestAt !== finding.latestAt ? (
            <p>Most likely: {presentation.likely}</p>
          ) : null}
          <p className="text-xs font-medium">{presentation.confidence}</p>
          <p
            className={
              finding.latestPostsVerified
                ? "text-muted-foreground"
                : "border-l-2 border-amber-500 pl-3"
            }
          >
            {finding.latestPostsVerified
              ? "Latest X posts verified at check time. "
              : "Latest X feed not verified. "}
          </p>
          <p className="text-xs text-muted-foreground">
            Checked {presentation.checked}. Saved result, not a live feed.
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer content-center text-xs text-muted-foreground">
              Sources and reasoning
            </summary>
            <div className="space-y-2 pt-2">
              <p className="text-muted-foreground">{finding.confidenceReason}</p>
              <p className="text-muted-foreground">{finding.accessNote}</p>
              <div className="flex flex-wrap gap-x-4">
                {finding.sources.map((source, index) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center text-xs underline underline-offset-4"
                  >
                    Source {index + 1} · {source.access}
                  </a>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Check again for updates. Your account reading confirms an actual reset.
              </p>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
