import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Spinner } from "../ui/spinner";

export type EditFromHereMode = "branch" | "rewind";

export function EditFromHereDialog({
  open,
  initialText,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly initialText: string;
  readonly submitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (mode: EditFromHereMode, editedText: string) => void;
}) {
  const [editedText, setEditedText] = useState(initialText);

  useEffect(() => {
    if (open) setEditedText(initialText);
  }, [initialText, open]);

  const trimmedText = editedText.trim();
  const submit = (mode: EditFromHereMode) => {
    if (!trimmedText || submitting) return;
    onSubmit(mode, trimmedText);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup aria-busy={submitting}>
        <DialogHeader>
          <DialogTitle>Edit from here</DialogTitle>
          <DialogDescription>
            {submitting
              ? "T3 Code is sending this edit to the server. You can close this dialog while it finishes."
              : "Edit this user message, then choose whether to preserve this task or replace its later timeline."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Textarea
            aria-label="Edited message"
            value={editedText}
            onChange={(event) => setEditedText(event.currentTarget.value)}
            disabled={submitting}
            className="min-h-32"
          />
          {submitting ? (
            <p aria-live="polite" className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5 shrink-0" />
              Waiting for the server to accept this edit…
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Rewind current task removes the selected original message and all later messages, tool
              activity, and results from the active timeline before submitting this edit once.
            </p>
          )}
        </DialogPanel>
        <DialogFooter className="max-sm:gap-3">
          <DialogClose render={<Button variant="outline" className="min-h-11" />}>
            {submitting ? "Close" : "Cancel"}
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={!trimmedText || submitting}
            onClick={() => submit("rewind")}
          >
            Rewind current task
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={!trimmedText || submitting}
            onClick={() => submit("branch")}
            autoFocus
          >
            Start new task
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
