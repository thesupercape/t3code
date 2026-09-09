import { useAtomValue } from "@effect/atom-react";
import type { CommunityCheckState, EnvironmentId } from "@t3tools/contracts";
import {
  communityPostLabels,
  latestResetCheck,
  researchCheckDate,
} from "@t3tools/client-runtime/resetCheckPresentation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { Clock3Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function CommunityCheckPanel({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const atom = serverEnvironment.communityCheck({ environmentId, input: {} });
  const query = useAtomValue(atom);
  const start = useAtomCommand(serverEnvironment.startCommunityCheck, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelCommunityCheck, { reportFailure: false });
  const [command, setCommand] = useState<CommunityCheckState | null>(null);
  const [sending, setSending] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const state = latestResetCheck(Option.getOrNull(AsyncResult.value(query)), command);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => appAtomRegistry.refresh(atom), 3_000);
    return () => window.clearInterval(timer);
  }, [atom, running]);
  const act = async (action: typeof start) => {
    if (active.current) return;
    active.current = true;
    setSending(true);
    setError(null);
    try {
      const reply = await action({ environmentId, input: {} });
      if (reply._tag === "Success") setCommand(reply.value);
      else setError("Could not reach the community checker. Reconnect and try again.");
      appAtomRegistry.refresh(atom);
    } catch {
      setError("Could not reach the community checker. Reconnect and try again.");
    } finally {
      active.current = false;
      setSending(false);
    }
  };
  return (
    <CommunityCheckResult
      state={state}
      label={label}
      sending={sending}
      unavailable={query._tag === "Failure"}
      error={error}
      onStart={() => void act(start)}
      onCancel={() => void act(cancel)}
    />
  );
}

export function CommunityCheckResult({
  state,
  label,
  sending,
  unavailable,
  error,
  onStart,
  onCancel,
}: {
  state: CommunityCheckState | null;
  label: string;
  sending: boolean;
  unavailable: boolean;
  error: string | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  const running = state?.status === "running";
  const finding = state?.result;
  return (
    <section
      aria-label="Luna community check"
      className="mt-4 rounded-lg border border-border bg-card/20 p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">What people are saying</h3>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={sending || (!running && (unavailable || state === null))}
          onClick={running ? onCancel : onStart}
        >
          {running ? "Cancel community check" : "Check community with Luna"}
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
      >
        {running || sending ? (
          <Clock3Icon aria-hidden className="size-4 shrink-0 text-amber-500" />
        ) : null}
        {running
          ? "Luna is reading reset discussions on X… You can leave this page."
          : sending
            ? "Contacting Luna…"
            : `Separate from announcements. Runs on ${label} when pressed and uses Codex allowance.`}
      </p>
      {error || unavailable ? (
        <p role="alert" className="mt-2 text-sm">
          {error ?? "Community checker unavailable. Update or reconnect this computer's T3 server."}
        </p>
      ) : null}
      <a
        href="https://x.com/search?q=Codex%20reset&f=live"
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-9 items-center text-xs text-muted-foreground underline underline-offset-4"
      >
        Open latest discussion on X
      </a>
      {state?.status === "failed" ? (
        <p role="alert" className="mt-2 text-sm">
          {state.error}
        </p>
      ) : null}
      {state?.status === "cancelled" ? (
        <p role="status" className="mt-2 text-sm">
          Community check cancelled.
        </p>
      ) : null}
      {finding ? (
        <div className="mt-3 space-y-3 text-sm">
          <p>{finding.summary}</p>
          <p className="text-xs text-muted-foreground">
            Checked {researchCheckDate(state!.finishedAt)}. Saved snapshot, not a live feed.
          </p>
          <p
            className={
              finding.coverage === "live"
                ? "text-xs text-muted-foreground"
                : "border-l-2 border-amber-500 pl-3 text-xs"
            }
          >
            {finding.coverage === "live"
              ? "Live X sample read at check time. "
              : "Latest X discussion not fully verified. "}
            {finding.accessNote}
          </p>
          <ul className="divide-y divide-border">
            {finding.posts.map((post) => (
              <li key={post.url} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center underline underline-offset-4"
                  >
                    {post.author} ↗
                  </a>
                  <span className="text-xs text-muted-foreground">
                    {communityPostLabels[post.kind]}
                  </span>
                </div>
                <p>{post.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {researchCheckDate(post.publishedAt)} · {post.access}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Individual reports are not confirmation of your reset. Your account reading is the
            source for your quota.
          </p>
        </div>
      ) : null}
    </section>
  );
}
