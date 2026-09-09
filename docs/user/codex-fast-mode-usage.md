# Codex Fast Mode usage

Open Usage to see how much of the API estimate comes from Codex Fast Mode.
The page distinguishes recorded speed settings, user-reported Fast Mode
periods, and responses whose speed was not recorded.

Fast Mode consumes 2.5 times the Codex credits for GPT-5.6 and GPT-5.5, or
2 times for GPT-5.4. That is not an API billing multiplier. GPT-5.6 Fast Mode
API rates are currently twice the corresponding standard rates, including
cached input. These rates were checked on August 30, 2026 against
[Codex speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed)
and [API pricing](https://developers.openai.com/api/docs/pricing).

The Codex monitor's percentage comes from account observations. It already
reflects credit consumption, so T3 does not multiply that percentage again.
API-equivalent dollars are token-price estimates, not charges or a cash balance.

T3 records the service tier of turns it starts when Codex supplies a tier or
the request explicitly selects one. Transcript metadata takes precedence over
that requested tier, including a recorded downgrade to standard service.
User-reported periods apply only when neither source identifies the tier.

Future turns sent from T3 do not need manual time windows. Choose Fast or
Standard in the conversation's speed options; T3 records the selected tier
with the native turn and includes it in the next usage update. Switching Fast
Mode off explicitly restores standard service for the next turn, including
older saved boolean toggles. Steering an active turn does not change its speed.

Some Codex versions do not save speed settings in transcripts. T3 cannot
reconstruct those settings from token totals or today's Fast Mode switch.
Older unidentified responses keep standard estimates and appear in the
unknown-speed count. Native subagents and turns started outside T3 also need
their own recorded metadata. A parent's speed is not assumed for its children.

Changing the date range reuses cached token records. Pricing corrections do
not multiply token counts, duplicate sessions, or force a full history scan.
