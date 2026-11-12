# After Contact — the summary and wrap-up code on the demo page

Genesys writes an AI summary and a wrap-up code through **After Contact** at the end of *every*
interaction, not only the ones that reach a person. Showing that on the demo page answers the
question a contact-centre buyer always asks next: *fine, the agent handled it — but what does my
supervisor see, and what does it do to my reporting?*

The panel sits at the bottom of the side rail, in both channels, under the heading
"After the conversation". It stays dimmed while the conversation plays and lights up when it ends,
because that is when Genesys actually writes it.

---

## 1. What the panel can and cannot show

The wrap-up code can be real. The codes created for a customer are on disk in the AXL session, so
the demo can show the code a supervisor would genuinely pick.

**The generated summary text cannot be fetched.** `POST /api/v2/conversations/summaries/preview`
returns `200` with an empty body and delivers the generated prose on the user-scoped notification
topic `v2.users.{id}.conversations.summaries.settings.preview`. The harness authenticates with
OAuth client credentials, which has no user context and so cannot subscribe to it. There is no
supported way to read the text back.

So the prose is written by the author, and the page says so. The `source` field decides the wording
of the provenance line under the panel:

| `source`     | Shown on the panel                                                                 |
|--------------|------------------------------------------------------------------------------------|
| `org`        | Wrap-up code from this org's configured list. Summary written for the demo.         |
| `captured`   | Captured from the interaction.                                                       |
| `authored`   | Illustrative wording for the demo, laid out as this org's summary setting defines it. |

Use `captured` only if the text genuinely came off a real interaction. Claiming live Genesys output
for prose someone wrote is the one failure mode here that damages trust in the whole demo.

---

## 2. Where the real configuration comes from

Two files in the session folder, one level above `poc-demo/`:

- `summary-setting.json` — the configured custom summary: the participant labels, the predefined
  insights (reason for call, resolution, action items) and the custom entities a supervisor sees.
  Produced by the [ava-custom-summary](../../ava-custom-summary/SKILL.md) skill.
- `wrap-up-codes.json` — the codes actually created in the org. Produced by
  [ava-wrap-up-codes](../../ava-wrap-up-codes/SKILL.md). Also read as `wrapup-codes.json` or
  `wrapup-codes-created.json`, in either an array or `{ "codes": [...] }` shape.

Neither is required. Without them the panel still renders, but the entity labels are invented
rather than the customer's own, which is a weaker demo — so prefer running those skills first.

---

## 3. Building the block

```bash
# What codes does this org actually have?
node scripts/after-contact.mjs codes --recording <session>/poc-demo/recording.json

# Write the skeleton, with the org's real entity labels and a real code
node scripts/after-contact.mjs scaffold --recording <...>/recording.json \
  --code "Resolved - Self Service"

# For an interaction that reached a person
node scripts/after-contact.mjs scaffold --recording <...>/recording.json \
  --code "Transferred - Medical Review" --handoff --queue "DLD Medical Review"

# Verify before generating
node scripts/after-contact.mjs check --recording <...>/recording.json
```

`scaffold` refuses to overwrite an existing block without `--force`, and rejects a `--code` that is
not in the org list. It leaves the prose empty on purpose — fill in `summary.text`,
`reasonForCall`, `resolution`, `actionItems` and the entity values from what actually happened in
the conversation, then run `check`.

`check` is the gate worth caring about. Beyond the empty-field notes it fails the build when the
block and the conversation disagree:

- `disposition: "handoff"` but no agent turn offers or performs a transfer — **a problem**, because
  a demo that claims a hand-off the conversation never made will be caught on the first watch.
- `disposition: "contained"` but an agent turn mentions a person — a note, to confirm.
- an entity label that the org summary setting does not define — a problem.
- `wrapUpCode.source: "org"` for a code absent from the org list — a problem.

---

## 4. The block

```json
"afterContact": {
  "source": "org",
  "disposition": "contained",
  "wrapUpCode": { "name": "Resolved - Self Service", "source": "org" },
  "summary": {
    "settingName": "Utah DLD — AVA custom summary",
    "text": "A new Utah resident called to establish what he needed ...",
    "reasonForCall": "New resident transferring an out-of-state licence.",
    "resolution": "Resolved in full without a transfer.",
    "actionItems": ["Resident to bring the document checklist to Springville"],
    "entities": [{ "label": "Residency status", "value": "New resident" }]
  }
}
```

With `disposition: "handoff"`, add the hand-off and what the receiving agent is shown:

```json
"handoff": {
  "queue": "DLD Medical Review",
  "reason": "Medical review requires a licensed examiner",
  "agentSees": [
    { "label": "Wrap-up code", "value": "Transferred - Medical Review" },
    { "label": "Reason for call", "value": "Vision certificate submitted for review" }
  ]
}
```

Entity labels must match `summary-setting.json`. `check` enforces that, because a label the
customer does not recognise is worse than no panel at all.

---

## 4a. Showing the hand-off itself

The panel describes the hand-off; these two additions let the demo *play* it.

**Give the person a turn.** A message with `role: "human"` is someone who took over after the
transfer. It is rendered as its own speaker everywhere — a green, named bubble in the web chat, its
own name in the voice transcript and in `transcript.md`, and its own voice in the call audio — so a
viewer is never left thinking the AVA said it.

```json
{
  "useCaseId": "escalation",
  "role": "human",
  "speaker": "Dana, licensing examiner",
  "text": "Thanks for holding — this is Dana. I have the assistant's summary in front of me: …"
}
```

Have them open on the summary. That is the entire argument for After Contact: the caller does not
repeat the six things they have already explained. Choose their voice with `voice.tts.humanVoice`
(default `Charlotte`); synthesis resolves it only when a `human` turn exists, so contained calls
cost nothing extra.

**Mark the transfer on the agent turn.** The turn that performs the transfer should carry an
escalation action:

```json
"actions": [{
  "type": "escalation",
  "name": "transfer_to_queue",
  "label": "transfer to a person",
  "input": { "queue": "…", "reason": "…" },
  "output": { "wrapUpCode": "…", "summaryAttached": true },
  "status": "ok"
}]
```

This is what `check` looks for, what the video counts in its "Transfers to a human" tile, and what
turns the closing capability banner into "Warm hand-off" instead of claiming no transfer happened.

In the call video this also produces the **Agent Copilot scene** — the receiving agent's screen,
sliding in as the transfer lands and holding while the person speaks, showing the queue, the
wrap-up code, why it came to them, the reason for call and the first few extracted fields. It is
built automatically from the `afterContact` block; there is nothing extra to author. Values are
clipped to the first clause because a panel of prose is unreadable at video scale — the demo page
shows them in full.

---

## 5. Where it appears

- **demo.html** — the "After the conversation" card in the side rail of both channels. In the
  digital channel it lights up when the replay finishes; in the voice channel when the video ends,
  and it dims again if the viewer scrubs back into the call.
- **transcript.md** — an "After the conversation" section with the disposition, code, summary
  setting, narrative, insights, action items, and an entities table.
- **the call video** — the Agent Copilot scene at the hand-off, the "Warm hand-off" capability
  banner, and honest outcome tiles ("Resolved by the agent 6/7", "Transfers to a human 1").
