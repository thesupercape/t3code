# Codex service-tier accounting

The active T3 home's `userdata/usage-codex-service-tiers.jsonl` records native
session IDs, turn IDs, and requested service tiers. It contains no prompt text
or credentials. `CodexSessionRuntime` reports accepted turn starts to the
adapter's append-only writer. Steering does not create another tier record.
A failed journal write logs a warning but must not fail the user's turn.

Usage first uses transcript service-tier metadata, then the exact native
session/turn journal entry. It never matches by title or parent thread.
The API estimate uses the rate table's priority or flex columns. Unsupported
tiers and missing tier-specific rates remain unpriced. GPT-5.6 long-context
priority rates use the documented 2x standard rate when the catalogue omits
those fields. Provider-reported dollar amounts are never multiplied.

For explicitly user-reported history, place an array in
`userdata/usage-codex-fast-windows.json`:

```json
[
  {
    "sinceTime": "2026-08-30T23:00:00Z",
    "untilTime": "2026-08-31T03:00:00Z",
    "note": "User reported Fast Mode from 6 PM through 10 PM America/Chicago"
  }
]
```

Bounds use usage-event timestamps, inclusive start and exclusive end. Windows
apply only to this environment's Codex transcripts, only to supported GPT
families, and only when stronger evidence is absent. Overlapping windows do
not stack. Preserve a copy before editing an existing correction file. Removing
a window removes its inferred tier on the next uncached or explicit refresh;
it does not edit transcripts. Never install a sample correction as a default.

The per-file scan cache keeps its compatible format and appends optional tier
and native-turn fields. Existing cached records stay usable with unknown speed.
Only raw transcript metadata is cached. Journal and manual-window attribution
run during aggregation so a correction affects warm history immediately.

The small parsing and attribution helpers are retained as testable boundaries
between local evidence, transcript records, and price calculation. They avoid
putting file I/O or user-specific time windows inside the pricing functions.
