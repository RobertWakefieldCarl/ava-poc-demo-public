---
name: ava-poc-demo
description: >-
  Records a multi-use-case conversation against a published Genesys Cloud AVA using its mock Data
  Action data, then renders a demo page that looks like the customer's own website with a branded
  chat widget carrying the customer's logo, plus a branded call video of that same conversation and
  a Markdown transcript. Use when asked for a POC demo, customer demo page, demo
  recording, demo HTML, chat replay, AVA product/marketing video, call video, or a shareable
  walkthrough of an AVA built with the ava-* and axl-* skills.
disable-model-invocation: true
metadata:
  version: 1.0.0
  author: Stern (custom)
compatibility: >-
  Node.js 22+. Playwright (for the customer page capture). user-ava-harness MCP for the
  cicero_* recording tools. ffmpeg for the voice channel. Reads .ava-lifecycle/<slug>/ and writes
  axl-sessions/AXL-<customer>/poc-demo/.
---

# AVA POC Demo

Produces a **shareable demo of a published AVA** in two channels:

| Channel | What it renders | Switch |
|---------|-----------------|--------|
| **Digital** | A real conversation recorded against the live agent, replayed as an animated web chat on a screenshot of the **customer's own web page**, with the **customer's logo in the chat widget** | `--digital` |
| **Voice** | A branded MP4 of that same conversation, spoken aloud and played back with capability chapters and a seekable call transcript | `--voice` |
| **Both** | Both, behind a channel switcher in one page (**default — build this unless told otherwise**) | `--both` |

Both channels come from the **one** conversation recorded in Step 3, so they tell the same story
and voice costs no extra recording. Build both every time unless the facilitator narrows it.

> **Digital channel vs voice AVA — two different things.** `ava.channel` (`voice`, `chat`,
> `messaging`) says what the real AVA runs on and drives the *wording* everywhere, so a voice AVA's
> replay is labelled "Recorded phone call · shown here as a transcript". The `--digital/--voice`
> switches choose which *artifact* to render. A chat AVA still gets a voice panel if you build one,
> and a voice AVA still gets an honest digital panel — the channel wording stays truthful either way.

> **Lifecycle position:** [build](../ava-build/SKILL.md) → [test](../ava-test/SKILL.md) →
> [evaluate](../ava-evaluate/SKILL.md) → **poc-demo** → [axl-takehome](../axl-takehome/SKILL.md)

Resolve `<SkillDir>` as the directory containing this file. Run all commands from the workspace
root (where `.ava-lifecycle/` and `axl-sessions/` live).

## Outputs

All under the AXL session folder for this AVA — `axl-sessions/AXL-<customer>/poc-demo/` — alongside
the session's other customer-facing artifacts (`spec-artifact.md`, `mock-data.html`, `pov-deck.html`,
`run-artifact.html`). The lifecycle folder `.ava-lifecycle/<slug>/` stays an **input** to this skill;
nothing is written there.

| Artifact | Purpose |
|----------|---------|
| `demo.html` | Self-contained animated demo — the deliverable to send or present |
| `transcript.md` | Full conversation transcript including tool calls and demo data |
| `recording.json` | Machine record of the conversation — re-render without re-recording |
| `assets/page.jpg`, `assets/logo.*`, `assets/brand.json` | Captured customer page, logo, brand colors |
| `assets/call-demo.mp4`, `assets/call-poster.png` | Voice channel only — the rendered call video and its poster frame |
| `review/demo-initial.png`, `review/demo-played.png`, `review/demo-voice.png` | Verification screenshots |
| `demo.zip` | Handoff bundle of everything above, written automatically into the same folder |

`demo.html` inlines its **images** as data URIs, so a digital-only demo opens standalone and can be
emailed as one file. Inlining costs about a third again in size, so keep the backdrop web-sized —
Step 1 handles this. The **MP4 is linked, not inlined**, so any demo with a voice channel must
travel with its `assets/` folder (or as `demo.zip`).

## Quick reference

| Need | Reference |
|------|-----------|
| Driving the conversation, picking use cases, using mock data | [references/recording-guide.md](references/recording-guide.md) |
| Capture troubleshooting, manual branding overrides | [references/branding-capture.md](references/branding-capture.md) |
| Building the call video from call audio | [references/voice-video.md](references/voice-video.md) |
| Sharing the skill and its API key with a team | [references/distributing.md](references/distributing.md) |
| `recording.json` shape | [assets/recording-template.json](assets/recording-template.json) |

| Script | Purpose |
|--------|---------|
| `scripts/capture-customer-page.mjs` | Step 1 — backdrop, logo, brand colors |
| `scripts/build-voice-video.mjs` | Step 4v — transcript → call MP4, wired into the recording |
| `scripts/voice/*.mjs` | The three stages behind it: synth, plan, render |
| `scripts/generate-demo.mjs` | Step 5 — `demo.html` + `transcript.md`, then auto-zips the folder |
| `scripts/verify-demo.mjs` | Step 6 — play it in a browser, assert, screenshot |
| `scripts/package-demo.mjs` | Step 7 — refresh `demo.zip` so it includes `review/` |
| `scripts/lib/zip-demo.mjs` | Shared packaging used by both of the above |
| `scripts/credentials.mjs` | API keys in the OS keystore — `set`, `status`, `bootstrap`, `seal` |

## Workflow

```
- [ ] 0. Preflight — resolve slug, published AVA, channel, demo type, customer, use cases
- [ ] 1. Capture the customer's web page, logo and brand colors
- [ ] 2. Plan the conversation arc across the use cases, confirm with the facilitator
- [ ] 3. Record the conversation live via cicero_*
- [ ] 4. Write recording.json
- [ ] 4v. Voice channel only — build the call video from that transcript
- [ ] 5. Generate demo.html + transcript.md (auto-zipped into demo.zip)
- [ ] 6. Verify the demo plays
- [ ] 7. Refresh demo.zip to include review/, then hand off
```

Step 4v runs only for `--voice` and `--both`. It reads `recording.json`, so it comes **after**
Step 4 — and because it speaks the Cicero transcript, every demo type needs Step 3. The one
exception is the recorded-call route in §3–§5 of
[voice-video.md](references/voice-video.md), where the audio comes from a real call instead.

---

### Step 0 — Preflight

Resolve, in this order:

0. **Session folder** — `axl-sessions/AXL-<customer>/`, the destination for everything this skill
   writes. If several `AXL-*` folders exist, ask which session this demo belongs to — never guess,
   and never default to the most recent. If none exists, create one from the customer name
   confirmed in step 3, following the [axl-lab-facilitator](../axl-lab-facilitator/SKILL.md)
   convention: `AXL-<customername>`, lowercased, spaces and punctuation collapsed to hyphens
   (`AXL-welbehealth`, `AXL-acme-bank`). There is no fallback location — the demo is a
   customer-facing artifact and belongs with the session's others.
   Everything below is read from the lifecycle folder and written to `<session>/poc-demo/`.
1. **Lifecycle slug** — from the user, `.ava-lifecycle/<slug>/sage-agent.json`, or session `ava-slug.txt`.
2. **`agent_id` and `version`** — from `sage-agent.json`. The AVA must be **published** (TestReady or
   ProductionReady); both are executable through Cicero when the version is passed explicitly.
   If nothing is published, stop and route to [ava-build](../ava-build/SKILL.md).
3. **Customer name and website URL** — ask the facilitator if not already known from the AXL session
   folder (`axl-sessions/AXL-<customer>/`) or the design artifact.
3b. **Channel** — voice, chat or messaging, from the design artifact's role and the AVA's
   configuration. The digital panel always *renders* as a chat widget, because a transcript is the
   only honest way to show a phone call on a page, but the wording throughout must match the real
   channel. Record it as `ava.channel`; everything downstream reads it.
3c. **Demo type** — **assume `--both`.** Build the digital *and* voice channels unless the
   facilitator explicitly asked for one of them ("chat only", "just the video", `--digital`,
   `--voice`). Do not ask which they want, and do not narrow the scope because voice looks
   expensive — the call video is built from the Step 3 transcript, so it needs no call recording
   and no extra conversation. Narrow to `--digital` only when the facilitator says so, or when
   Step 4v genuinely cannot run (no ElevenLabs key, no ffmpeg) — in which case say which
   prerequisite is missing rather than silently dropping the channel.
4. **Use cases** — read `design-artifact.json` (`tools`, `role`) and any scenarios in
   `.ava-lifecycle/<slug>/test-cases/`. Propose the set to cover and let the facilitator adjust.
5. **Mock data** — read the mock values the AVA will actually return, so the conversation uses inputs
   that resolve. See [recording-guide.md](references/recording-guide.md).

Confirm the use-case list with the facilitator before recording — this is the demo's storyline.

### Step 1 — Capture the customer page

```bash
node "<SkillDir>/scripts/capture-customer-page.mjs" \
  --url "https://www.customer.com" \
  --out-dir "axl-sessions/AXL-<customer>/poc-demo/assets"
```

Writes `page.jpg`, a best-effort `logo.*`, and `brand.json` with the brand colors. The script
dismisses cookie banners, **removes the site's own live-chat launcher**, scrolls to trigger lazy
images, samples the brand color from the rendered header band, and picks a logo-badge background
that keeps the logo legible (a white wordmark lifted from a dark header gets a dark badge).

Read the summary it prints — it is the check, not decoration:

- **`chat widget`** — if it says `none found` on a site you know runs one, pass `--keep-chat-widgets`
  off and inspect `page.jpg` before continuing. Two chat widgets in one demo is the single most
  noticeable defect this skill can ship, because the customer spots it instantly.
- **`page.jpg` size** — the backdrop is inlined at roughly 1.33×. Over about 1.2 MB, re-run with
  `--quality 70` or `--max-height 3000`.
- **`brandColor`** — sampled from the header pixels when the band is colored, otherwise derived from
  CSS. Both are best-effort.

If the logo or brand color is wrong, override it in `recording.json` —
see [branding-capture.md](references/branding-capture.md).

> Use the customer's **public** site only, and keep the result inside the POC deliverable. The
> demo depicts a Genesys AVA on a mock-up of the customer's page; it is not a live integration.

### Step 2 — Plan the conversation arc

Write **one continuous conversation** that moves through the use cases in a natural order — not
one disconnected snippet per use case. A realistic arc:

1. Open with a simple question that needs no authentication.
2. Move into an authenticated lookup (this is where the mock data earns its keep).
3. Chain a second intent off the first ("while you're here, can you also…").
4. Include one moment of friction — a correction, an ambiguous request, or an escalation — so the
   demo shows judgment rather than only happy paths.
5. Close cleanly.

Confirm the arc with the facilitator before spending Cicero calls.

### Step 3 — Record live

Drive the real AVA, playing the customer. One session for the whole conversation so context carries
across use cases:

| Tool | Use |
|------|-----|
| `cicero_start_session(agent_id, version, language, start_context)` | Opens the session, returns the greeting and first `turn_id` |
| `cicero_send_message(agent_id, session_id, text, previous_turn_id)` | Sends one customer turn |
| `cicero_end_session(agent_id, session_id)` | Cleanup when the arc is complete |

For each turn capture: the customer text, the AVA's reply **verbatim**, and every tool call with its
name, inputs and outputs. Carry `turn_id` forward from each response.

Never edit the AVA's words when writing the recording. If a reply is poor, that is a finding for
[ava-critique](../ava-critique/SKILL.md) — fix the AVA and re-record rather than rewriting the
transcript. Full turn-by-turn guidance: [recording-guide.md](references/recording-guide.md).

`--voice` needs this step too: the call video speaks this transcript. Skip it only if you are
taking the recorded-call route in [voice-video.md](references/voice-video.md) §3–§5.

### Step 4 — Write recording.json

Write `axl-sessions/AXL-<customer>/poc-demo/recording.json` following
[assets/recording-template.json](assets/recording-template.json). Populate `customer` from
`assets/brand.json` — including `pageImage`, which is whatever filename the capture actually wrote —
tag every message with its `useCaseId`, and attach each turn's tool calls to the **agent message they
produced** (they render before that bubble, as the AVA "thinking").

Set `ava.channel` from Step 0. The generator derives the transcript's channel line, the page header
and the widget's default title, subtitle and input placeholder from it, so a voice AVA is never
described as web chat. Override any of those in `widget` when the customer uses different language
for their own phone line.

Set `disclaimer` when the default ("every name, reference number and record ... is demonstration
data") doesn't name the kind of data this demo actually shows.

Give each use case 2–4 `mockData` rows — these show in the demo's side rail while that chapter plays
and make it obvious which demo values are in use.

For the voice channel, set only the inputs Step 4v needs: `voice.format`, `voice.phoneNumber`,
`voice.callerName` and any `voice.tts` overrides. Step 4v fills in the rest of the block — video
path, poster, capability chapters, outcomes and the call transcript — so there is no point writing
those by hand. The full shape is in [voice-video.md](references/voice-video.md) §9.

### Step 4v — Build the call video (voice channel)

Only for `--voice` and `--both`. Produces a branded MP4 that visualizes what the agent is doing:
captions, status chips, action cards, a capability banner, and a recap/outcome/CTA ending.

By default the video is built **from the Step 3 transcript** — the same Cicero conversation the web
chat uses, so both channels tell one story. The speech is synthesized with ElevenLabs, the scenes
are inferred from the use cases and tool calls, and the finished MP4 is wired back into
`recording.json` automatically.

```bash
# always look at the sample frames before committing to a full render
node "<SkillDir>/scripts/build-voice-video.mjs" \
  --recording "axl-sessions/AXL-<customer>/poc-demo/recording.json" --contact-sheet

node "<SkillDir>/scripts/build-voice-video.mjs" \
  --recording "axl-sessions/AXL-<customer>/poc-demo/recording.json"
```

Needs an ElevenLabs API key, Playwright and ffmpeg — and behind a TLS-intercepting corporate
proxy, `NODE_OPTIONS=--use-system-ca`. Store the key once in the OS keystore; it is never written
into the skill or the session folder:

```bash
node "<SkillDir>/scripts/credentials.mjs" set elevenlabs
```

Set `voice.tts.agentVoice` and `callerVoice` rather than relying on
the defaults; voice names vary by account. Use `--dry-run` to see the line and character
count before spending credits; synthesized lines are cached per line, so re-running after an edit
only re-speaks what changed. Work lands in `poc-demo/voice-build/`, the MP4 in `poc-demo/assets/`.

Agree the aspect ratio and the agent's voice with the facilitator before starting, and **read
`voice-build/scenes.json`** — it is the editorial layer, inferred but meant to be tuned. Re-run
`scripts/voice/render-call.mjs` alone after editing it; that skips synthesis.

**The size is projected before the render starts**, which matters because a four-minute
conversation is a ten-minute render. If the projection exceeds 20 MB the build stops and prints the
options; take them to the facilitator rather than silently shipping a huge attachment or silently
degrading their video. `--accept-size` proceeds as-is, `--crf 28` trades quality for about 25%,
lowering `waves` in `scenes.json` saves about half with no content change, and a shorter
conversation is the editorial option. `--estimate` reports the projection without rendering.

A 90-second portrait video lands around 7–8 MB and a 3½-minute landscape one around 14 MB. Details
and the measurements behind the defaults are in [voice-video.md](references/voice-video.md) §8.

To build from a **real call recording** instead, follow §3–§5 of
[voice-video.md](references/voice-video.md). That route is manual and takes hours; use it only when
the customer wants their own recorded call.

### Step 5 — Generate

```bash
node "<SkillDir>/scripts/generate-demo.mjs" \
  --recording "axl-sessions/AXL-<customer>/poc-demo/recording.json" \
  --both
```

| Flag | Effect |
|------|--------|
| `--both` | Both channels behind a switcher (**default** — omit it and you get this) |
| `--digital` | Chat replay only |
| `--voice` | Call video only |
| `--video <path>` | Override `voice.videoFile` |
| `--no-embed` | Link images instead of inlining them |
| `--embed-video` | Inline the MP4 too — only sensible under about 10 MB |
| `--no-zip` | Skip the automatic `demo.zip` |

Writes `demo.html` and `transcript.md` beside the recording, then **zips the folder in place** to
`demo.zip` — `demo.html`, `transcript.md`, `recording.json` and the whole `assets/` folder. The
bundle is written on every run, so the demo is always handoff-ready and a linked MP4 can never get
separated from the page in transit. Step 7 re-runs the same packaging once `review/` exists.

With the default `--both`, a recording with no `voice` block degrades to the digital channel (and
vice versa) with a note, so existing recordings keep working untouched.

Re-run after any recording edit — it is cheap and never re-contacts the AVA.

### Step 6 — Verify the demo plays

```bash
node "<SkillDir>/scripts/verify-demo.mjs" \
  --demo "axl-sessions/AXL-<customer>/poc-demo/demo.html"
```

Drives the demo in a real browser at 4× and fails loudly on the defects that are invisible in the
HTML source: a backdrop or logo whose data URI didn't decode, playback that stalls before the last
turn, a use-case rail that lost chapters, unreplaced `{{tokens}}`, and any console or page error. It
detects which channels the page has and checks each one — for voice it also confirms the **MP4
actually loads** (a linked video that 404s looks fine in the source and fails in the room) and that
the capability and transcript rails are complete. Writes `review/demo-initial.png`,
`review/demo-played.png` and `review/demo-voice.png`, and exits non-zero on any problem.

Then **open the review screenshots** and judge the things a script cannot:

- The widget sits over the page without covering the customer's logo or headline.
- The logo is legible in the widget header, and the brand color looks like the customer's.
- On the voice panel, the video is the right aspect ratio and the poster frame looks deliberate.

If the backdrop is wrong, re-capture (Step 1); if only the colors are wrong, override them in
`recording.json` and re-generate — neither needs a re-recording.

### Step 7 — Package and hand off

Step 5 already wrote `demo.zip`. Re-run the packaging now so the bundle also carries the review
screenshots Step 6 produced:

```bash
node "<SkillDir>/scripts/package-demo.mjs" \
  --demo-dir "axl-sessions/AXL-<customer>/poc-demo"
```

Refreshes `demo.zip` in the same folder with `demo.html`, `transcript.md`, `recording.json`,
`assets/` and `review/`. Use `--customer-only` for just the two files a customer receives.

A digital-only `demo.html` is self-contained, so sending it alone is always a valid alternative —
but **a demo with a voice channel must be sent as the zip**, because the MP4 is linked rather than
inlined. `--customer-only` warns when it would drop a linked video.

Then report the artifact paths and the use-case count.

## The demo page

Presenter controls on the **digital** panel:

| Control | Behavior |
|---------|----------|
| Play / Pause | Starts or holds the replay mid-animation |
| Restart | Replays from the first turn |
| 1× / 1.5× / 2× / 4× | Speed, changeable mid-playback |
| Use-case rail | Click any use case to jump straight to it |
| Show what the AVA is doing | Toggles the tool-call chips; click a chip for its inputs and outputs |

On the **voice** panel:

| Control | Behavior |
|---------|----------|
| Play / Pause / Restart | Drives the video; native controls are available too |
| 0.75× / 1× / 1.25× / 1.5× | Playback rate |
| Capability rail | Click a capability to seek to that moment; the current one highlights as it plays |
| Call transcript | Click any line to seek to it; the active line highlights and auto-scrolls |
| Follow transcript | Turns the auto-scroll off when the presenter wants to read ahead |

With `--both`, a switcher at the top moves between them and always stops the channel being left, so
two demos never play over each other.

Before play, the chat widget shows only the AVA's greeting and the video shows its poster frame, so
the page can sit on screen while the presenter talks.

## Invocation examples

- `/ava-poc-demo` — resolve the current lifecycle and walk the workflow, building **both** channels
- "Build a POC demo for Acme Dental covering benefits, claims and finding a dentist"
- "Chat demo only, no video" (`--digital`)
- "Make a product video from this call recording" (recorded-call route, then `--voice`)
- "Add the call video to the demo we already built" (Step 4v, then re-generate with `--both`)
- "Re-record the demo — the AVA's escalation wording changed" (Steps 3–5)
- "Regenerate the demo HTML" (Step 5 only, from the existing `recording.json`)

## Guardrails

- **Record, don't write.** Agent turns must be verbatim from Cicero. A scripted demo that the AVA
  cannot reproduce live will fail in front of the customer.
- **Name the real channel.** The demo renders as a chat widget whatever the AVA is. Set
  `ava.channel` and let the generator describe it; never let a voice AVA be labelled web chat.
- **One chat widget per demo.** If the customer's own launcher survived into the backdrop, re-capture
  before generating. Never hand over a page showing two assistants.
- **Never post-process the generated files.** If `demo.html` or `transcript.md` says something wrong,
  fix the recording or the generator and re-run. A patch script that rewrites the output silently
  stops working the next time the generator changes, and the next person will not know it existed.
- **Mock data only.** Never put real customer records, live account numbers, or PII in a recording.
  The footer and transcript both state the data is for demonstration.
- **Mask real call audio unless told otherwise.** A recorded phone call carries real voices and real
  details. Default to masking names, numbers and identifiers, and say that you did — see
  [voice-video.md](references/voice-video.md) §5.4.
- **Never invent outcome metrics.** Capability banners and outcome tiles may only state what the
  call actually shows.
- **Send the zip when the demo has a voice channel.** The MP4 is linked, so a lone `demo.html` will
  show a dead player.
- Do not present the demo as a deployed web-chat integration — it is a recorded mock-up.
- Capture only the customer's public pages; never a page behind a login.
- Re-record after any AVA change. A stale transcript misrepresents current behavior.

## Completion message

```
AVA POC demo complete — <customer> / <AVA name> v<version>
  Channel: <voice|chat|messaging>   Use cases: <N>   Turns: <T>   Tool calls: <K>
  Verified: <T> of <T> turns played, no errors
  Demo:       axl-sessions/AXL-<customer>/poc-demo/demo.html
  Transcript: axl-sessions/AXL-<customer>/poc-demo/transcript.md
  Recording:  axl-sessions/AXL-<customer>/poc-demo/recording.json
  Bundle:     axl-sessions/AXL-<customer>/poc-demo/demo.zip
```
