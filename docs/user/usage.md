# Review usage

For a birthday palette and tap effects on these screens, see [Celebrate your birthday](birthday-theme.md).

The Usage page combines Codex, Claude Code, Gemini, OpenCode, and configured chat archives from
your connected environments. It reads local history and shows API-equivalent token cost, processed
tokens, cache savings, provider shares, and model breakdowns. Subscription billing is separate from
the raw token cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, **90 days**, **120 days**, and **1 year** ranges use daily resolution. Cost and token
toggles update both the headline and chart, and refreshing rescans every connected environment.

In **Hourly model usage**, each bar shows processed tokens for Astra, Sol, Luna, Terra, or another
recorded model. Select an hour to see its token total and estimated dollar cost; token totals include
cached input, and empty hours remain visible so the timeline stays accurate.

Parsed transcripts are cached individually on the environment that owns them. Expanding to a range
that has not been viewed before may briefly warm older history; afterward, unchanged chats reuse
their cached records and only new or edited transcript files are parsed again.

Usage history is independent from the providers enabled for new T3 Code chats. Disabling Claude
Code or leaving Gemini unavailable as a chat provider does not remove their locally stored history
from Usage. Gemini totals include Gemini CLI sessions and locally recorded Antigravity token totals.
OpenCode totals come from its local session database and remain available when OpenCode is disabled
as a provider for new chats.

## Understand API estimates

Recorded dollar costs take precedence over token estimates. Otherwise, Usage applies the latest
cached model prices at standard text-token rates, including each request's context-length tier.
Provider namespaces are kept separate: a reseller's rate cannot replace a direct provider's rate.
Unknown models and missing rates are marked unpriced, not treated as free usage. Reasoning tokens
already included in output are not charged twice.

These are current-price equivalents, not historical invoices. They do not reconstruct fast,
flex, batch, regional, or negotiated pricing. Cache-write estimates use the standard short-lived
cache rate; storage duration, long-lived cache premiums, audio/image-specific rates, and tool fees
are not reconstructed from token totals. Provider-reported costs may themselves be estimates from
the local harness. A subscription's quota percentage is not a dollar balance.

### Import product chat archives

Configured ChatGPT and Google AI Studio exports appear as **ChatGPT archive** and **AI Studio
archive**. Raw chat text stays on the environment that reads it. Only aggregate token and cost
buckets cross the T3 connection.

ChatGPT exports retain message dates and model names but do not include an API token ledger. Usage
estimates each message from its text, reconstructs the parent context for each assistant response,
and places the result on the original message date. Reimporting an overlapping export does not count
the same conversation message twice.

AI Studio exports include per-message token counts but omit the original chat date and request-level
usage ledger. Usage reconstructs the input context for each model turn and uses the downloaded
file's timestamp on the graph. A notice stays visible while this source contributes. Exact duplicate
files are counted once by content; separate branches remain separate chats.

Imported product chats are API-equivalent estimates, not proof of API charges. Unknown experimental
models remain unpriced when no documented paid equivalent exists.

## Monitor Codex usage

Open **Codex usage & resets** from Usage. You can also tap or hold the **Codex icon/name**,
or tap **Usage & resets →** below its row. **Usage** in the header takes you back.
Scrolling cancels the hold gesture. Enter and Space activate the focused Codex button.

On macOS, T3 reads the signed-in Codex allowance through the configured Codex provider when
reset history is requested, at most once every five minutes. It stores only the timestamp,
remaining percentage, and reset time in the local T3 data directory.

The monitor leads with remaining usage and the total used in the current account cycle.
For example, 81% remaining means 19% used. If tracking began at 83%, the monitor observed
a two-percentage-point drop. Those two points are not the cycle total.

**Recorded** shows saved readings. **To reset** adds the current-pace projection and a target
that leaves 3% unused. The forecast blends the observed pace with the current weekly average.
Earlier cycles do not influence it. Gaps over an hour are not joined.

Turn **API cost pace** on or off beneath the chart to compare the blue projection.
It divides API-equivalent spending from the last six hours by elapsed hours, including idle
time. If monitoring began more recently, it uses that shorter interval, with at least one hour
required. Only the current cycle and selected computers contribute. The server measures costs
after the interval start through the latest account reading, using the same pricing and
source deduplication as the remaining-value estimate.

Estimated time to empty is remaining API value divided by average dollars per hour. For
example, $50 remaining at $10/hour gives five hours. The caption shows the measured window,
hourly cost, and outcome; **API value runs out** gives its projected timestamp. The blue line
maps the declining dollar balance onto the chart's remaining-percentage scale and stops at
zero. A complete zero-cost interval produces a flat line with no exhaustion timestamp.

The **Runway plan** turns that projection into downtime. It shows how long usage would be
unavailable before the account's scheduled reset if the measured dollar burn continues. Choose
the **maximum time without usage** you can tolerate; 12 hours is the default. The planner also
calculates the maximum average dollars per hour that would reach zero at that deadline. A lower
burn keeps usage available longer, while a higher burn exceeds the selected downtime limit.
Elapsed time since the last reading is charged at the measured rate, so the estimate advances
without waiting for another chart sample. If the rate is zero, the planner says usage lasts to
the reset rather than inventing an exhaustion time.

Stale readings, incomplete or unpriced costs, and a missing remaining-value estimate withhold
the blue projection. Elapsed clock time does not count as newly measured spending. The orange
line retains its percentage-based estimate for comparison. Model changes can affect Codex
allowance differently, so neither line guarantees future capacity or changes measured usage.

An earlier public reset announcement changes the planning deadline, not your account balance.
The original weekly timer stays under **Source and weekly timer**. Announcements come from
Tibo's public posts through the independent Reset Beacon feed. The source link and time
interpretation remain visible. A missing or expired announcement falls back to the account timer.
A countdown reaching zero never creates a reset observation or changes usage to 100%.

The page checks readings every minute and public news every five minutes while open.
The separate Codex Limits collector records every five minutes while its computer is awake
and signed in, even with T3 closed. Readings older than 15 minutes are labeled stale.
News requests send no account credentials, usage totals, or chat data.
Saved quota history and completed cost snapshots survive page navigation and server restarts,
with bounded retention. Chart readings support hover, tap, and keyboard inspection.

Press **Refresh** to reload saved readings, refresh public reset news, and check API costs for
the newly read interval. The button shows progress and ignores repeated taps until it finishes.
Unchanged transcripts keep their cached records. On the mobile app, pulling down does the same.
Growing chats read only their appended text when the saved cursor is valid. Public reset news
updates independently and does not hold the usage refresh open.
Refresh does not force a new collector sample or run Luna. Use **Check X with Luna** separately.
Long windows such as **90 days** and **120 days** warm in bounded transcript batches while the
page remains open. If every selected computer fails to return a result, the window is shown as
**Unavailable** rather than as zero usage.

The view uses the latest continuous monitoring run for current measurements. A gap over 24 hours
begins another run. Older samples remain saved and appear in **Reset history**. When a new cycle
has too little current data to calibrate a pace or dollar value, the monitor may show a provisional
estimate based on the immediately preceding completed cycle. It includes that cycle's local date
range and is replaced automatically when current-cycle calibration is valid. Percentages are never
combined across reset boundaries. The observation interval is not an exact reset timestamp. A banked
reset or account change can look similar.

The runway baseline uses the account timer. **Banked manual resets** are shown separately and
never get added to the current balance or treated as an extension of the current timer. A full
manual reset refreshes both the short and weekly windows and starts a new approximately seven-day
window. The planner can show each credit's expiry and whether it remains available at the
estimated empty time when the connected account snapshot supplies expiry dates. Current saved
snapshots may provide only the verified count and check time, in which case expiry eligibility
is left unknown. If you redeem one, wait for the next account reading before planning the new
window; the planner never redeems credits for you.

### Check reset announcements with Luna

Press **Check X with Luna** on **Codex usage & resets**. The selected quota-source computer
runs a Codex Luna check with live web search. It uses that computer's Codex sign-in and allowance.
The status changes while the check runs. **Cancel** stops it; checks stop after three minutes.
Leaving the page does not cancel the job. Returning shows its latest status and saved result.

Results include source links, a check time, confidence in the proposed timing, and a date/time
range when the announcement is ambiguous. Times use your device's time zone. A saved result
is not a live feed; press the button again for updates.

X may block access to its current feed. In that case the result explicitly says **Latest X feed
not verified**, even when search results or an archive contain an announcement. Indirect evidence
cannot receive high confidence. Failed access is not evidence that no reset is coming.

The check does not change your quota, account timer, or planning deadline. The existing public-news
feed supplies the planning deadline, and account readings confirm actual resets. The button is
Codex-only and requires a connected, updated T3 server with Codex installed and signed in.

### Read community discussion with Luna

Under **What people are saying**, press **Check community with Luna**. This is a separate job
from the announcement check, with its own running status, cancel button, and saved result.
It uses Codex allowance only when pressed and stops after three minutes. Leaving the page
does not stop it. The controls and linked posts work on mobile too.

Luna returns up to six X posts with summaries, authors, timestamps when verified, and labels
for reset reports, people still waiting, questions, speculation, or other reactions. Individual
reports do not confirm your reset and never change your quota or planning deadline.

The result states whether it read live posts or only partial evidence. X can block current
replies or require sign-in; a saved or indexed post is not a complete live feed. Failed access
is shown as unavailable, not as evidence that nobody is discussing the reset.

### Understand the dollar estimate

The web monitor puts the chart first. Use the header links to jump to API value,
the token planner, Reset history, or Luna research. Expand **Inspect recorded readings** to scrub
through the saved observations with a pointer or arrow keys.

**How far could the rest go?** compares alternative uses of the estimated remaining
API value on Astra, Sol, Terra, and Luna. Its default input/cache/output mix comes
from the exact monitored interval. The model breakdown below it uses that same
interval, excludes Spark, and counts reasoning inside output once. Older servers
without model totals show a pending state; example mixes remain available.

Choose an example mix, output only, or uncached input only to explore other work.
**Custom mix** lets you set the output share and the cache hit rate for input.
Long-context and Fast mode controls apply their respective token-price multipliers.
Each row spends the entire estimate, so rows cannot be added together. M means
million and B means billion. Prices have a verification date and a source link.
Tool charges and regional surcharges are excluded. These are API-price comparisons;
changing models can change Codex consumption, so they do not guarantee a number of
Codex tokens. Incomplete cost data withholds the comparison.

Luna starts with dated public search results and retains useful indexed posts when
X blocks direct access. Indexed discussion is labeled partial and cannot confirm
a firsthand reset. Third-party probabilities and banked-credit announcements cannot
supply a broad-reset time window.

On your configured birthday, the celebration keeps your selected T3 theme. Make a
wish to put out the candle, run it again to relight it, or open **birthday.log** for
another note. Confetti is brief and respects the tap-effects and reduced-motion settings.

**Used while monitored** prices Codex transcripts from the same observed interval.
**Value of usage remaining** uses that cost per observed percentage point. It shows **Learning**
until at least five points have been observed. A qualified earlier reset cycle can calibrate a
shorter interval provisionally until current measured costs are ready. Bounded zero-use timer
changes totaling up to 60 minutes can bridge the interval without counting as resets. Spark is
excluded because it has a separate quota.

Dollar values are API-equivalent estimates, not subscription bills, cash balances, or credits.
Model mix and missing history affect them. Incomplete scans and missing prices withhold a new
current estimate while a refresh is pending; previously saved exact costs remain labeled with
their calculation time. A qualified earlier reset cycle can provide a labeled provisional model
and value estimate until current costs are ready. Within the same cycle, the last complete cost
remains visible through its recorded date while the scan warms, using that saved percentage
denominator until a newer complete reading replaces it.

The monitor defaults to the quota-source computer. Use **Tracking and computers** to opt in to
other computers for cost comparison. Selecting an unavailable computer withholds the combined
estimate. Select computers using the same Codex account. Percentages are never added across machines.
The tracker does not verify account identity or identify chats copied between distinct sources.
The power monitor is separate and does not contribute to Codex quota totals.
