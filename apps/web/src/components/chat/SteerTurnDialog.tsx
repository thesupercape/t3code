import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "../ui/dialog";

export function SteerTurnDialog({
  environmentId,
  threadId,
  activeTurnId,
  disabled,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  activeTurnId: TurnId | null;
  disabled: boolean;
}) {
  const steerTurn = useAtomCommand(threadEnvironment.steerTurn, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [targetTurnId, setTargetTurnId] = useState<TurnId | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetIsRunning = targetTurnId !== null && targetTurnId === activeTurnId;

  const submit = async () => {
    if (!targetIsRunning || !targetTurnId || !text.trim() || submitting || disabled) return;
    setSubmitting(true);
    setError(null);
    const result = await steerTurn({
      environmentId,
      input: { threadId, expectedTurnId: targetTurnId, text: text.trim() },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not submit steering.");
      return;
    }
    setText("");
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setTargetTurnId(activeTurnId);
          setError(null);
        }
        setOpen(nextOpen);
      }}
    >
      {activeTurnId !== null ? (
        <div className="mx-auto flex w-full max-w-3xl justify-end pb-1">
          <DialogTrigger render={<Button size="sm" variant="ghost" disabled={disabled} />}>
            Steer active turn
          </DialogTrigger>
        </div>
      ) : null}
      <DialogPopup aria-busy={submitting}>
        <DialogHeader>
          <DialogTitle>Steer active turn</DialogTitle>
          <DialogDescription>
            Send an instruction to this running Codex turn. Its model and permissions stay
            unchanged. This does not queue another turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Textarea
            aria-label="Steering instruction"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            disabled={submitting}
          />
          {!targetIsRunning ? (
            <p role="status" className="text-sm text-muted-foreground">
              This turn has ended. Close this dialog to choose another turn.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={() => void submit()}
            disabled={!targetIsRunning || !text.trim() || submitting || disabled}
          >
            {submitting ? "Submitting…" : "Send instruction"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
