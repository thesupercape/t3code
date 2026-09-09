# Saved quota history integration

`UsageService.readSummary` accepts optional `includeQuotaHistory` and `quotaIntervals` fields.
The reset page uses `quotaHistoryOnly` to read observations without scanning transcripts,
fetching model prices, or waiting for the transcript-scan lock. Its subsequent `quotaIntervals`
request scans only Codex sources. Ordinary usage requests continue to include all providers.
Old clients and servers can continue using usage contract 6. New clients detect missing optional
fields and show an unsupported-server state rather than treating missing values as zero.

The server reads Codex Limits' Windows `LOCALAPPDATA/CodexLimits/state.json` (or macOS
`~/Library/Application Support/CodexLimits/state.json`). Operators can set
`T3CODE_QUOTA_HISTORY_PATH` to a compatible saved file on another platform. Clients cannot supply
filesystem paths. The import is read-only, bounded to 2 MiB and 5,000 samples, and accepts only
the main `codex` limit with a 10,080-minute window. It returns sanitized observation time,
remaining percentage, and scheduled reset time. On macOS, when no external history file exists,
the reset-history read asks the configured Codex desktop daemon for `account/rateLimits/read` at
most once every five minutes and stores the same sanitized samples in the T3 state directory.
Direct CLI mode fails closed instead of starting a second app-server against an active Codex home,
and the request never starts a model turn. External Codex Limits files remain read-only; the
native fallback owns only its T3 state file.

`packages/shared/src/usageQuota.ts` groups consecutive observations. Reset-clock changes within
one minute are treated as timestamp jitter. A percentage increase or a larger clock change
starts another period. A changed clock without evidence of replenishment is ambiguous unless
the observations straddle the previously scheduled boundary. Reset events are observation
intervals, not exact timestamps; the final group has no confirmed reset.

The client requests at most 64 ordered, disjoint exact cost intervals, with two UTC calendar days
of scan padding. `QuotaCostAccumulator` receives only records accepted by the existing
`UsageAggregator` deduplication pass. It prices records strictly after the first observation and
through the last observation. Spark/bengalfox records are excluded from the main quota comparison.
It returns separate interval totals per physical source so duplicate environment aliases do not
inflate the merge. Raw transcript text never crosses the wire.

The ordinary Usage totals are unchanged. The summary cache key includes the history flag and
intervals, including the distinction between omitted intervals and an empty interval request.
The second cost query reuses the same per-file transcript cache as ordinary Usage.

The tracker stores no account identity. The web, desktop, and native-mobile views display estimates
with an explicit assumption that selected transcript sources cover the same account without copied
chats. A confirmation checkbox does not verify identity and no longer gates the calculation.
`remainingValueUsd` estimates the last observed percentage even in an unfinished period;
`unusedValueUsd` additionally requires a classified, closely observed reset boundary.
Complete same-window results remain visible during background refresh; initial, partial, failed,
or unpriced results cannot produce a remaining-value estimate.
Each reset page also retains up to 128 complete period calculations for its mounted lifetime.
The key includes tracker ID, selected environment IDs and physical source fingerprints, and the
full observed period. A later incomplete result can display that labeled snapshot, never a new
conversion from partial costs. No snapshot is persisted as live account data.
Partial or unpriced costs are withheld. The five-percentage-point minimum limits unstable
conversions from rounded observations. The one-hour reset-observation limit bounds, but does
not eliminate, uncertainty about usage between observations. No model-equivalence guarantee or
fixed subscription-to-dollar exchange rate is implied.

`quotaHistoryPoints` supplies both clients with elapsed-time coordinates and line-break flags.
Graphs do not interpolate across observation gaps over an hour or reset changes, and never extend
the last saved percentage to the present. Dollar comparison bars use the same per-period values
as the text summaries. Presentation-only observation selection makes no usage requests.

## Ongoing observations and pace

The Windows Codex Limits app now supports `--collect-once` with no window. Its separately installed
Windows task records every five minutes and at user sign-in. Collection is independent of T3,
uses `account/rateLimits/read`, and never starts a model turn. A process mutex prevents concurrent
writers. The parser selects the 10,080-minute main Codex window explicitly, rather than selecting
whichever short or weekly window has less remaining. Failed reads leave history intact. On macOS,
the T3-native fallback collects when reset history is requested and applies the same five-minute
throttle; it does not run a background collector while T3 is closed.

Web and native reset pages refresh only the history query every minute and on foreground return.
The timer does not trigger cost scans unless observations actually change. The quota-history
importer remains read-only; collecting another reading needs no backend restart or new wire fields.

`usageQuotaForecast.ts` is shared by both clients. It blends the current observed slope with the
current weekly-window average, with a minimum hour and one percentage point before using an
observed slope. Earlier periods no longer affect the forecast. Reset-separated periods prevent
negative burn. Its target reserve is explicitly
3%; it does not read or alter the tray application's reserve setting. The measurement timestamp
anchors all estimates; the UI clock only updates countdowns and freshness. A reading older than
15 minutes or an expired window is historical, never a current balance. Actual lines break at
long observation gaps. Projection lines are separate and reach zero at exhaustion, not at reset
when exhaustion occurs sooner. A current single observation can use the weekly-window average
without waiting for chat scans or the dollar-conversion calibration threshold.

## Current monitoring view

`quotaMonitoringSamples` retains the most recent run after a gap over 24 hours. Both reset pages
apply it before requesting cost intervals. This leaves archived tracker data intact while excluding
old runs from the UI and cost calibration. Total cycle usage is `100 - remainingPercent`;
monitored usage is `first.remainingPercent - last.remainingPercent`. Only the latter can calibrate
costs for that same shorter interval. The page displays both and labels the pre-monitoring usage.

`packages/client-runtime/src/resetAnnouncements.ts` owns a public, unauthenticated news read from
Reset Beacon's documented `/api/forecast`. It accepts only fresh, scheduled announcements with a
Tibo X status URL, Codex reset text, and a valid deadline. It excludes banked-reset text. Requests
omit credentials, referrers, and trace propagation; they time out after ten seconds and recur every
five minutes only while the page is mounted. Unmount interrupts the request and schedule.
This adapter is shared by web and native mobile. No account or transcript data reaches the feed.

A valid earlier announcement changes the planning deadline and target pace, never the saved
account percentage or weekly clock. The UI labels the independent feed and links the source post.
Its Pacific-local-time interpretation is disclosed. Expired news, failed reads, and elapsed
deadlines fall back to the weekly timer. A new observed account cycle retires the old announcement.
The feed is not an authoritative account-reset detector. Actual reset records still require
account observations, and their cause can remain ambiguous.

## On-demand Luna research

`UsageResetCheck` owns one bounded research job per environment. Authenticated read scopes can
read status; orchestration-operate scopes are required to start or cancel. Concurrent starts share
one job. Three typed RPC methods carry `ResetCheckState` through the shared client runtime to web,
desktop, and native mobile. Clients poll every three seconds only while a job is running.

The runner uses the configured Codex executable and effective Codex home. It pins `gpt-5.6-luna`,
live web search, read-only sandboxing, and no approval prompts. Shell and multi-agent tools and
project instructions are disabled, and user config is ignored. API-key environment variables are
not passed. Before launch, a ten-second public request fetches Reset Beacon's current announcement
snapshot. Only a fresh, size-bounded subset is supplied as explicitly untrusted, indirect evidence.
No credentials, referrers, or tracing headers accompany the request, and redirects are refused.
The job receives this snapshot, a fixed public-news prompt, and the current time, never quota or
chat data. Normal Codex rollouts remain enabled so this work appears in transcript usage.

The job stops after three minutes and supports cancellation. Temporary output files are scoped to
the subprocess. Structured output uses Codex's supported JSON Schema subset; server validation
separately bounds text, source count, URLs, timestamps, and date ranges. A claimed current-feed read
needs a cited original profile/feed URL. Indirect or ambiguous timing cannot receive high confidence.
Unverified feed access cannot produce a reassuring no-reset result.

The last state is atomically saved to `codex-reset-check.json` in the provider status cache. It
survives navigation and server restarts; an interrupted job becomes a failed check on restart.
The UI labels the check time and saved nature of the result. Research never changes account quota,
the weekly timer, observed resets, or the public-feed planning deadline. Direct X access remains
dependent on the search provider and X's access restrictions; no browser cookies are exported.

`UsageCommunityCheck` owns a second job and `codex-community-check.json` result. Its three
community RPCs use the same read/operate authorization split. The two jobs share the fixed
Luna process runner, timeout, cancellation, and persistence implementation, but never share
state. The community schema has no reset-time or account-percentage fields. Source validation
accepts bounded X status links from community authors, rejects duplicate post IDs, and requires
a dated original for firsthand reset/waiting classifications. Both clients label limited access.

Transcript scan budgeting uses the same validated append offset as the reader. A growing
200 MB chat with 40 KB appended consumes 40 KB of the scan budget. A missing parser cursor,
truncation, provider change, or incomplete JSONL boundary requires a full read instead.
Cache replacement uses the existing atomic-write helper. Usage refresh awaits new observations
and their matching cost interval; reset news updates through its independent watcher.
The scan semaphore serializes the initial disk-cache load. Only a completed load is remembered,
so cancelling the first request does not poison later reads with a cached interruption.
Directory walks check file metadata in batches of at most 32, retaining the same timestamp
filter and recursive discovery. Transcript parsing remains bounded separately by unread bytes.
