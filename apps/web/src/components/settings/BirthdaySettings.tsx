import {
  BirthdayCelebrationPreference,
  MAX_BIRTHDAY_NOTES,
  MAX_BIRTHDAY_NOTE_LENGTH,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isBirthdayPreference = Schema.is(BirthdayCelebrationPreference);

export function BirthdaySettings() {
  const saved = usePrimarySettings((settings) => settings.birthdayCelebration);
  const update = useUpdatePrimarySettings();
  const connected = usePrimaryEnvironment();
  const [month, setMonth] = useState(saved?.month.toString() ?? "");
  const [day, setDay] = useState(saved?.day.toString() ?? "");
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [tapEffects, setTapEffects] = useState(saved?.tapEffects ?? true);
  const savedNotes = saved?.notes?.join("\n") ?? "";
  const [notesText, setNotesText] = useState(savedNotes);
  const [error, setError] = useState("");
  useEffect(() => {
    setMonth(saved?.month.toString() ?? "");
    setDay(saved?.day.toString() ?? "");
    setEnabled(saved?.enabled ?? true);
    setTapEffects(saved?.tapEffects ?? true);
  }, [saved?.month, saved?.day, saved?.enabled, saved?.tapEffects]);
  useEffect(() => setNotesText(savedNotes), [savedNotes]);

  return (
    <SettingsSection {...searchableSetting("birthday-celebration")}>
      <p className="text-sm leading-relaxed text-muted-foreground">
        A birthday palette, a little cake, and confetti when you tap. Only on your birthday, using
        this device's local date. Your usual theme returns afterward.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const notes = notesText
            .split(/\r?\n/)
            .map((note) => note.trim())
            .filter(Boolean);
          if (
            notes.length > MAX_BIRTHDAY_NOTES ||
            notes.some((note) => note.length > MAX_BIRTHDAY_NOTE_LENGTH)
          ) {
            setError(
              `Use up to ${MAX_BIRTHDAY_NOTES} notes, each ${MAX_BIRTHDAY_NOTE_LENGTH} characters or fewer.`,
            );
            return;
          }
          const next = {
            month: Number(month),
            day: Number(day),
            enabled,
            tapEffects,
            ...(notes.length || saved?.notes !== undefined ? { notes } : {}),
          };
          if (!isBirthdayPreference(next)) {
            setError("Choose a valid month and day.");
            return;
          }
          setError("");
          update({ birthdayCelebration: next });
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            Month
            <select
              aria-label="Birthday month"
              required
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"
            >
              <option value="" disabled>
                Select month
              </option>
              {Array.from({ length: 12 }, (_, index) => (
                <option key={index} value={index + 1}>
                  {new Date(2000, index, 1).toLocaleString(undefined, { month: "long" })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-24 flex-col gap-1 text-sm">
            Day
            <input
              aria-label="Birthday day"
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={31}
              step={1}
              value={day}
              onChange={(event) => setDay(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"
            />
          </label>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 accent-current"
          />
          Celebrate my birthday
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={tapEffects}
            onChange={(event) => setTapEffects(event.target.checked)}
            className="size-4 accent-current"
          />
          Confetti and tap effects
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Reduced motion turns animations off. The date is saved privately on your connected T3
          server, shared with its paired clients, and never added to the code repository. No birth
          year is stored.
        </p>
        <label className="flex flex-col gap-2 text-sm">
          Personal birthday notes
          <textarea
            aria-describedby="birthday-notes-help"
            value={notesText}
            onChange={(event) => setNotesText(event.target.value)}
            rows={6}
            className="min-h-36 w-full resize-y rounded-md border border-input bg-background p-3 text-base leading-relaxed"
          />
        </label>
        <p id="birthday-notes-help" className="text-xs leading-relaxed text-muted-foreground">
          One note per line, up to {MAX_BIRTHDAY_NOTES} notes of {MAX_BIRTHDAY_NOTE_LENGTH}{" "}
          characters. Saved privately with your birthday, not in Git. These replace the built-in
          notes and appear in Usage and Codex monitor. Leave blank to use the built-in notes again.
          Opening a note never reads your chats or calls a model.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!connected} className="min-h-11">
            Save birthday
          </Button>
          {saved ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setError("");
                update({ birthdayCelebration: null });
              }}
            >
              Remove birthday
            </Button>
          ) : null}
        </div>
      </form>
    </SettingsSection>
  );
}
