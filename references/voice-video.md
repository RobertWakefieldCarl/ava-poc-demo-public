# Voice call video

Produces a branded MP4 that visualizes what the agentic virtual agent is doing, then feeds it into
the demo page's voice channel. The call can come from **the Cicero transcript this skill already
recorded** (the default, fully scripted) or from **a real call recording** (ASR-driven).

The call audio plays over an animated "live call" screen: agent and caller avatars with a
live waveform, a speaker tag, captions, status chips, cards showing what the agent is doing, and an
**AGENTIC VIRTUAL AGENT · CAPABILITY** banner naming the capability at the moment it happens. The
video is framed by a branded intro and an ending sequence (recap → business outcome → Genesys outro
→ call to action).

Everything renders offline: HTML/CSS/JS frames driven by a virtual clock, screenshotted with
Playwright and encoded with ffmpeg. No video-generation model is involved.

Work in `axl-sessions/AXL-<customer>/poc-demo/voice-build/` and write the finished MP4 to
`axl-sessions/AXL-<customer>/poc-demo/assets/`.

---

## 1. Choosing a source

| | Transcript-driven (default) | Recorded call |
|---|---|---|
| Comes from | `recording.json` — the Cicero conversation from Step 3 | An audio or video file of a real call |
| Speech | Synthesized with ElevenLabs | The real voices |
| Timing | Known exactly, because we generate it | Recovered with VAD + ASR |
| Scene design | Auto-planned from use cases and tool calls, then hand-tuned | Hand-designed from the transcript |
| Effort | Minutes, scripted | Hours, mostly manual |
| Use it when | Almost always — both channels then tell the same story | The customer wants their own recorded call, or no AVA phone line exists |

Everything from §6 onwards (brand, layout, scene vocabulary, render engine, wiring) applies to both.
Sections 3–5 are only needed for the recorded-call route.

---

## 2. Transcript-driven build (default)

One command takes the recording to a finished, wired-up MP4:

```bash
node "<SkillDir>/scripts/build-voice-video.mjs" \
  --recording "axl-sessions/AXL-<customer>/poc-demo/recording.json"
```

It runs three stages, each also runnable on its own from `scripts/voice/`:

| Stage | Script | Produces |
|---|---|---|
| 1. Speak the transcript | `voice/synth-call.mjs` | `voice-build/call-mix.wav`, `voice-build/data.js` |
| 2. Derive the visuals | `voice/plan-scenes.mjs` | `voice-build/scenes.json` |
| 3. Render and encode | `voice/render-call.mjs` | `assets/call-demo.mp4` + poster |

Then it writes the `voice` block back into `recording.json` — video path, poster, format, capability
chapters and the full call transcript, all timed in seconds **into the finished MP4**. So after it
finishes, `generate-demo.mjs --both` just works with no hand editing.

### Prerequisites

- An ElevenLabs API key, stored once in the OS keystore
- Playwright with Chromium, and ffmpeg on PATH

```bash
node "<SkillDir>/scripts/credentials.mjs" set elevenlabs   # prompts; input is hidden
node "<SkillDir>/scripts/credentials.mjs" status           # shows a fingerprint, never the key
```

The key is read from stdin, so it stays out of shell history and the process list, and it is
stored by the operating system — DPAPI on Windows, Keychain on macOS, libsecret on Linux — never
in the skill folder, the session folder or `recording.json`. `ELEVENLABS_API_KEY` still overrides
the keystore when it is set, which is what CI and one-off runs should use. `credentials.mjs clear`
removes it.

Behind a TLS-intercepting corporate proxy, Node rejects the ElevenLabs certificate with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Trust the machine's certificate store instead of disabling
verification:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
```

`eleven_v4_turbo` (the default), `eleven_v4`, `eleven_v3`, `eleven_turbo_v2_5`, `eleven_turbo_v2`,
`eleven_flash_v2_5` and `eleven_multilingual_v2` all work, and all of them return `pcm_24000`, so
the fast no-ffmpeg audio path is the normal one. A key restricted from `/v1/models` is fine — the
model id is sent directly, and an id that does not exist fails loudly with `model_not_found`.

### Flags worth knowing

| Flag | Why |
|---|---|
| `--dry-run` | Reports line and character counts before spending any credits |
| `--contact-sheet` | Renders one frame per scene into `review/` and stops. **Always do this first.** |
| `--format 16x9` | Landscape instead of the default vertical |
| `--agent-voice`, `--caller-voice` | ElevenLabs voice name or id for each speaker |
| `--replan` | Rebuild `scenes.json`, discarding hand edits |

Every synthesized line is cached in `voice-build/lines/` keyed by its text, voice and model, so
re-running after editing one reply only re-synthesizes that reply. A re-run where nothing changed
costs nothing and does not even need the API key.

### Timing

Lines are laid end to end with deliberate gaps: 0.45 s when the speaker changes, 0.3 s when it
does not, plus 1.1 s before any agent turn that ran tools so its action card has room to land.
Because we generated the audio there is no silence to tighten, so the time map is the identity and
`fwd()` is a no-op — scene times are written directly in call seconds.

### Tuning the result

`scenes.json` is the editorial layer and is meant to be read and edited. The planner infers:

- a status chip per use case, spanning that chapter's turns
- a white data card per use case, from its `mockData` rows (first three)
- an agent-action card for every turn that ran tools
- the capability banner, from the shape of each turn — several asks in one breath, a barge-in
  ("wait", "hold on", "actually"), a tool call, a verification-flavoured tool name, and the close
- recap lines, one per capability actually shown
- outcome tiles that only count what the recording contains: use cases, tool calls, zero transfers
  and the call's real duration

Overlapping capability windows are clipped so only one banner is ever on screen. What the planner
cannot infer is tone, emphasis and anything about the customer's business — that is the edit pass.
Re-run `render-call.mjs` alone after editing; it does not re-synthesize.

### Voice configuration

Set these under `voice.tts` in `recording.json` (all optional):

```json
"voice": {
  "format": "9x16",
  "phoneNumber": "+1 555 010 0199",
  "callerName": "Member",
  "tts": {
    "agentVoice": "Rachel",
    "callerVoice": "Adam",
    "model": "eleven_v4_turbo",
    "agentSettings": { "stability": 0.45, "style": 0.2 }
  }
}
```

Voices accept either an ElevenLabs voice id or a name as shown in the ElevenLabs UI; resolved ids
are cached in `voice-build/voices.json`. Accounts usually label voices as
`Adam - Dominant, Firm`, so the short leading name is enough. **Name a voice explicitly** — if you
do and it is missing, the run stops and lists what the account has; if you leave it to the default
and that voice is absent, the skill substitutes a conversational voice of the expected gender and
prints which one it picked, which is convenient but not a choice you want made for a deliverable. Pick an agent voice that matches the one the real AVA uses
in production — if [ava-voice-humanizer](../../ava-voice-humanizer/SKILL.md) defined a Voice
Persona for this AVA, use that voice here so the demo sounds like the deployed agent.

> The transcript is the AVA's own words from Step 3. Do not rewrite lines to make the synthesized
> read flow better — if a reply sounds wrong spoken aloud, that is a finding for the AVA's voice
> guidelines, not something to paper over in the video.

---

## 3. Inputs to collect (recorded-call route)

| Input | Required | Notes |
|---|---|---|
| Call audio | yes | Any format ffmpeg reads. May be mono (mixed) or stereo (one speaker per channel). |
| Start/end trim | optional | e.g. "from 40s to 3:15". |
| Customer logo | optional | Already captured by `capture-customer-page.mjs` into `assets/`. |
| Partner logo (e.g. AXL – Agentic Experience Labs) | optional | Usually a PNG on dark blue. |
| Reference video | optional | Only to confirm layout; the spec below already encodes it. |
| Masking rules | ask if unclear | Brand names, customer names, ID numbers, phone numbers. Demos often say "no need to anonymize". |
| CTA phone number | optional | Shown big on the last screen, exactly as given. |
| Format | default vertical | Offer the other format afterwards. |

If the user gives no instruction on personal data, default to **masking** it on screen and say so;
if they say it's a demo and no anonymization is needed, show it as spoken.

> **Recording the source call.** Only needed on this route. If no call recording exists yet,
> either take the transcript-driven route in §2 instead, or place a real call to the AVA's
> demo line covering the planned use cases, following the conversation arc in
> [recording-guide.md](recording-guide.md). The voice arc should mirror the digital one so the two
> channels in the demo tell the same story.

---

## 4. Environment facts (recorded-call route)

These cost hours to rediscover:

- **A constrained sandbox often has 1 CPU and a 300 s limit per command.** Run anything long (ASR,
  frame rendering, encoding) **detached** and poll it:
  `(setsid nohup python3 -u job.py > job.log 2>&1 < /dev/null &)` then `sleep 240; tail job.log`.
  Plain `nohup … &` gets killed when the tool call ends.
- `/bin/sh` has **no brace expansion** (`cp {a,b}` fails). Use a loop.
- **Never `pkill -f name.py`** inside a command line that contains `name.py` — it kills your own shell.
- Allowed downloads: GitHub release assets, PyPI, raw.githubusercontent.com. Hugging Face and the
  official Whisper CDN are blocked.
- Rough speeds on 1 CPU: Whisper-turbo int8 transcribes about 1 s of audio per 2–3 s; Playwright
  renders about 12–15 frames/s at 1080×1920 JPEG; a libx264 `veryfast` encode of 4 minutes takes
  about 4–5 min.

### Setup

```bash
pip install sherpa-onnx --break-system-packages -q
# Whisper large-v3-turbo (564 MB), the best quality available here
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2 | tar xj
# Whisper small (640 MB): faster, used for word-boundary scans
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2 | tar xj
curl -sLO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
# Roboto, which matches the Genesys look
mkdir -p build/fonts && curl -sLo build/fonts/Roboto.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf"
```

ffmpeg, Pillow and Playwright (Chromium) are normally preinstalled.

---

## 5. Pipeline (recorded-call route)

```
audio ──► ASR + speaker split ──► cleaned segment list (who / start / end / text)
      ──► silence-tightened edit + time map + loudness envelope ──► data.js
scenes designed from the transcript ──► app.js (cards, chips, CAPS banner, ending)
video.html + data.js + app.js ──► Playwright frames ──► ffmpeg (+ audio delayed by intro) ──► MP4
```

### 5.1 Prepare audio

```bash
ffmpeg -y -ss 40 -to 195 -i in.mp4 -c:a aac -b:a 192k clip.m4a   # optional trim
ffmpeg -y -i clip.m4a -ac 1 -ar 16000 a16.wav                    # for ASR
ffmpeg -y -i clip.m4a -ac 1 -ar 48000 a48.wav                    # for the final mix
```

**Check for one speaker per channel first.** Split L/R and compare per-second RMS. If one channel is
loud while the other is quiet, alternating, the channels are speakers. That makes diarization trivial
and lets you level-match them. Real call recordings (e.g. WhatsApp exports of a contact-center call)
often look like this.

### 5.2 Transcribe

Use Silero VAD (`min_silence_duration=0.35`, `max_speech_duration=20`) to cut speech segments, then
decode each one with Whisper turbo, padded by 0.25 s before and 0.2 s after. **Set `language`
correctly** ("en", "pt", …): forcing the wrong language makes Whisper *translate*. For each segment,
also compute the median pitch (autocorrelation, 70–400 Hz). Write `start`, `end`, `f0` and `text` for
every segment to JSON.

```python
rec = sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder="sherpa-onnx-whisper-turbo/turbo-encoder.int8.onnx",
    decoder="sherpa-onnx-whisper-turbo/turbo-decoder.int8.onnx",
    tokens="sherpa-onnx-whisper-turbo/turbo-tokens.txt",
    language="en", task="transcribe", num_threads=1)
```

### 5.3 Assign speakers (mono recordings)

- The **pitch** of each segment usually separates the two voices (e.g. agent ≈ 170–210 Hz,
  caller ≈ 100–130 Hz).
- **Segments that contain both voices** ("…your address? Yeah, yeah, it's mine.") need splitting.
  Print a 0.1 s pitch track for the segment (`A` = high, `c` = low, `.` = silence) and cut where the
  run changes.
- **Use content as the tie-breaker:** the agent greets, verifies, offers and confirms; the caller
  says "Wait", "Yes, thank you", "No, that's it".
- Then **hand-correct** the text into a final list of `(speaker, start, end, text)`: fix names,
  numbers, times ("9:15 a.m.") and ASR slips. Use context; for example, if the next turn says "open
  Outlook", the first one probably did too.
- Keep each original VAD segment as its own entry so caption timing stays accurate. Don't merge
  segments that have long gaps between them.
- Tell the user which lines were machine-transcribed or inferred.

### 5.4 Masking (only when requested)

Masking replaces sensitive words in the audio with a soft 800 Hz tone at amplitude 0.06, with 30 ms
fades, and shows a generic replacement on screen and in captions.

- **Locating a word:** decode growing prefixes of the segment with Whisper small in 0.12–0.2 s steps
  and see when the word first appears. Refine with an RMS envelope plot.
- **Generic replacements:** "Horizon", "Banco Horizonte", "Rafael", `••••-99`, `0800 000 0000`,
  "[date of birth]".
- **Long masked spans** (such as a phone number) get cut down to about 1 s instead of leaving several
  seconds of tone.
- **Real third-party logos** never go on screen unless the user supplies them for this purpose.

### 5.5 Tighten silence

Pad every speech segment by 0.4 s before and 0.35 s after, and merge any that overlap. Shorten each
remaining gap to at most 0.35 s, cutting the audio with 12 ms fades. Record a time map,
`[[out_start, orig_start, dur], …]`, so scene timings can be written in original-audio seconds and
converted with `fwd(orig) → out`. Normalize the peak to 0.9. Compute a 30 fps RMS envelope
(normalized to the 99th percentile) to drive the waveform. If the speakers are on separate channels,
mix them to mono with a gain that equalizes the speech RMS of the two channels.

Write everything to `data.js`:

```js
window.DATA={segs:[{ch:"R"|"L",start,end,text}], map:[...], env:{L:[...],R:[...]}, callDur}
```

`ch:"R"` is the agent and `"L"` is the caller (for mono audio, use the same envelope for both).

---

## 6. Brand and layout spec

This is implemented in `scripts/voice/template/styles.css`. It is written down here because the
numbers are the spec — change the stylesheet and this section together, and re-read §7's
readability rules before moving anything.

### Colors and type

- **Font:** Roboto, 400–800.
- **Dark scene background:** `linear-gradient(180deg,#25336a,#202a59 45%,#1b2547)`.
- **Light (beige) scene:** background `#ECEBE4`, text navy `#1F2640`, secondary text `#4a5170`.
- **Accent orange:** `#ff5a1f`. **Highlight gradient:** `#f5b335 → #ff5a1f → #e8435a`, used for the
  second headline line, eyebrows and pill borders.
- **Green "done":** `#36c99a` / `#5ff0bd`. **Teal:** `#3fc8b0`. **Warning orange:** `#ff9a2e`.
- **Card styles:**
  - glass: `rgba(255,255,255,.075)` fill, 2 px border `rgba(255,255,255,.2)`, radius 26
  - `hl`: gradient border, orange → teal
  - `warn`: orange border with shield icon; use for guardrails
  - `ok`: green border
  - `white`: light journey or summary card with navy text
- **Background waves:** about 26 thin sine lines in orange, yellow, red, teal and blue, drifting
  slowly. On dark scenes they fill the lower part of the frame; on beige scenes they sit at the
  bottom edge.

### Logos

- **Genesys:** if you only have the logo inside a frame of a reference video, extract it. Key it
  against the frame background (distance from the background color gives alpha), then build a dark
  version (navy wordmark, orange glyph) and a white version. Crop the orange glyph on its own for the
  agent avatar.
- **Customer logo on white JPEG:** `alpha = clip((255 - min(R,G,B))/90)`, then un-premultiply the
  color and crop to the bounding box.
- **Partner logo on dark blue PNG:** `alpha = max(clip((min(RGB) - 45)/170), clip((R - B - 70)/110))`.
  Set pixels with alpha below 80 to transparent to drop background specks, then recolor the white
  parts navy to get a version for beige backgrounds.
- **Small source logos come out soft;** tell the user and ask for an SVG or a large PNG.

### Vertical 1080×1920 call screen (px)

| Element | Position and style |
|---|---|
| Timer pill "● Live call  mm:ss" | top 58, centered, 430×78. Changes to "Call ended" with a grey dot. |
| Status chip | top 162, centered. Green check by default; orange with `!` or `?` for caller events. One at a time. |
| Cards zone | x 100, width 880, from top 262 to about 860. Never overlap the avatars. |
| Agent avatar | 180 px circle at (270, 880): rotating conic ring (orange/red/teal/blue) around the Genesys glyph. Glows orange while speaking. |
| Caller avatar | 180 px circle at (630, 880): person icon or initial on a blue gradient, white glow while speaking. |
| Waveform | 14 bars between the avatars, driven by the envelope. Orange for the agent, white for the caller, a dim flat line in silence. |
| Name labels | top 1078. "Agentic Virtual Agent / AI agent"; the caller uses their name or role. |
| Speaker tag | top 1170. "AGENTIC VIRTUAL AGENT · AI" (orange) or "CALLER" / "PATIENT" (white). |
| Caption box | top 1222. Dark rounded box, 46 px bold white, centered, max width 900. Chunks of at most 40 characters, broken at sentence ends, timed by character share of the segment. |
| Capability banner | top 1405, width 880. Gradient border; eyebrow "AGENTIC VIRTUAL AGENT · CAPABILITY", title 44 px, subtitle 27 px. |

### Horizontal 1920×1080

- **Left column (centered at x = 470):** pill at top 56, avatars at top 220 (lefts 200 and 560),
  names at 418, tag at 528, caption at 578 (40 px, max width 820), capability banner at 790
  (width 800).
- **Right column:** chips at top 48 centered at x = 1420; cards at left 980, width 880, shifted up
  120 px from their vertical positions; phone mockup at (1230, 150).
- **Waves:** across the full width from y = 640.
- **Ending screens** use two columns: headline on the left, list, tiles or phone tile on the right.

Implement horizontal as an override stylesheet (`!important` on positions) plus a `land.js` that
rebuilds the intro, recap, outcome, outro and CTA markup with the same element ids. That way one
`app.js` engine serves both formats.

---

## 7. Designing the scenes (the creative part)

Read the cleaned transcript and, for every turn, ask: **what is the AI agent doing right now that a
viewer can't see?** Make that visible. Write every time in *original-audio* seconds and convert it
with `fwd()`.

### Vocabulary of visuals

- **Intent / "Requests detected" card:** rows fill in *while the caller is still talking*, then a
  badge changes to "N intents". Ideal for several requests in one sentence.
- **Verification card:** a checklist (pending → active ring → green check) with masked or plain values.
- **Agent action card:** a ⚡ "AGENT ACTION · Done" card with one line, e.g. "Service health check:
  no active incidents", "Eligibility and network status checked", "Ticket T-10427 created" →
  "Ticket closed, notes attached".
- **Data cards:** current appointment or contract, offer or proposal, a slot picker with the chosen
  slot turning orange, a calendar with an invalid day in red and the chosen day in orange, a day-plan
  timeline.
- **Progress bar:** e.g. "Rescheduling…" that **pauses** with "Paused: answering the caller's
  question" during an interruption, then finishes after "Back to your…".
- **Guardrail card (`warn`):** shield icon with "Guardrail: …" and a one-sentence rule, e.g. "No cost
  guesses", "Never asks for the password", "Reset won't erase mail".
- **Phone mockup** (380×610) for guided troubleshooting, with one screen per instruction: a pulsing
  ring on the element to tap, then a spinner, then a green "Successfully authenticated", then the
  inbox filling with a "+N" counter. Use a **generic** app UI rather than a copy of a real product's
  interface.
- **Message notification:** the customer's logo or a generic bank icon, "Text message · now" or
  "WhatsApp · now", the message text, and attachment chips.
- **Map or diagram drawn in SVG,** e.g. clinic ↔ garage with a moving dashed arrow.
- **Final summary:** the same intent card with every row checked, plus any extra the agent added
  proactively (badge "Proactive").

### Capability banner: map every moment to one of these

| Capability | Typical trigger in the audio |
|---|---|
| Multiple inputs in one sentence | The caller packs several issues or facts into one turn; the agent plays them back. |
| Turn interruption | The caller says "Wait…" or barges in mid-instruction or mid-action; the agent answers and resumes. |
| Action execution | The agent checks, looks up, books, creates, closes or sends something. |
| Guardrails | Identity verification before accessing data, refusing to guess, safe or accurate guidance, not asking for secrets. |
| Business outcome | Resolved on first contact, no transfer, care gap closed, ticket documented. |

Empathy and proactive next-best-action are good secondary labels when they occur.

### Rules that keep it readable

- At most **one chip, one capability banner and two cards** visible at a time. Fade in and out over
  0.4 s, sliding up 28 px.
- Check every card's height so it ends above y = 860 in vertical layout.
- Hold cards for the whole stretch of talk they explain. Don't flash them.
- Use the caller's own words in the chips ("Patient cuts in: 'how much will I owe?'").
- Never invent facts or metrics. Outcome tiles may only state what the call shows (e.g. "<3 min from
  hello to fixed" only if the audio supports it).

### Timeline

1. **Intro (6 s, beige):**
   - customer logo first, if one was provided
   - "MEET THE" + Genesys logo
   - "Agentic Virtual Agent"
   - "One call." / gradient "Problem solved." (or "Everything handled.")
   - one sentence of context
   - partner logo small at the bottom

   Then, from 3.9 s, crossfade to dark with an "Inbound call · <Customer> <Service>" card showing a
   pulsing ring ("Answering…").
2. **Call:** the full tightened audio, starting at t = 6.0 s.
3. **Hold (1.6 s):** "Call ended".
4. **Recap (8.5 s, dark):** "In one call, the Genesys / Agentic Virtual Agent:" with five checked
   lines, one per capability, written for this call.
5. **Business outcome (6.5 s, dark):** "One call. / Fully resolved." with four gradient stat tiles
   (e.g. "3/3 Requests resolved", "+1 Care gap closed", "0 Transfers to a human", "2 Texts sent").
6. **Genesys outro (5.5 s, beige):** "Orchestrate every channel." / gradient "Resolve with AI." /
   "All in Genesys Cloud." / Genesys logo / pill "Meet the Genesys Agentic Virtual Agent".
7. **CTA (9 s, dark):**
   - partner logo
   - "TRY IT YOURSELF"
   - "Talk to the Agentic Virtual Agent / by phone."
   - "Call the demo line and play with the agent."
   - a gradient phone tile with a pulsing handset and the number exactly as the user gave it
   - "Powered by" + white Genesys logo

**Naming:** say "Agentic Virtual Agent" on screen (not "AVA") unless the user asks otherwise.
Captions always keep the speaker's actual words, even if the voice says "Ava".

---

## 8. Rendering engine (how app.js works)

The engine ships with this skill at `scripts/voice/template/` — `video.html`, `styles.css` and
`app.js`. `render-call.mjs` copies it into `voice-build/` alongside the generated `data.js`,
`scenes.js` and `assets.js`, so you normally never touch it. Read this section when you need to
extend it with a visual the scene vocabulary in §7 describes but the engine does not yet draw.

**The one rule: `render(t)` depends on nothing but `t`.** No real timers, no CSS animations, no
randomness. The frame renderer screenshots the page right after calling `render(f/30)`, so anything
time-dependent it cannot see will tear or jitter in the encode. Pulses and rotations are computed
as `Math.sin(t * k)`, never with `@keyframes`.

Layering runs backdrop → `#waves` canvas → scene content, because the scenes are transparent and
the page colour is crossfaded on `#bgBeige` underneath. A new element belongs inside its `.scene`,
not above the canvas.

The core helpers:

```js
const ease=x=>x<0?0:x>1?1:1-Math.pow(1-x,3);
function vis(t,a,b,d=0.4){ if(t<a||t>b+d) return 0; return Math.min(ease((t-a)/d),1-ease((t-b)/d)); }
function fwd(o){ for(const [os,s,d] of D.map){ if(o<s) return os; if(o<=s+d) return os+(o-s);} const l=D.map.at(-1); return l[0]+l[2]; }

// t  = seconds into the video      tc = t - INTRO, seconds into the call audio
// D  = window.DATA  from synth-call.mjs   S = window.SCENES from plan-scenes.mjs
```

Chips, cards and capability banners are built once from `S` and only have their opacity changed
per frame, which is why the planner clips overlapping capability windows — the engine's
last-one-wins loop would otherwise swap banners mid-fade.

Captions: split each segment's text into chunks of up to 40 characters, breaking after `.?!` once a
chunk is longer than 16 characters. Give each chunk the original-time span
`start + dur*charShare`, mapped through `fwd()` at **both** ends (so a cut inside a segment stays in
sync). Hide the caption 0.35 s after its chunk ends.

### Render and encode

`render-call.mjs` does this: Playwright at 1080×1920 (or 1920×1080), `render(f/30)` then a JPEG
screenshot per frame, then ffmpeg with the audio delayed by the intro length.

```bash
node "<SkillDir>/scripts/voice/render-call.mjs" --recording <recording.json> --contact-sheet
node "<SkillDir>/scripts/voice/render-call.mjs" --recording <recording.json>
```

**Always run `--contact-sheet` first.** It renders one frame inside each scene plus four across the
call into `review/`, in a few seconds. Look at them: overlapping cards, text overflow, the wrong
speaker tag, empty stretches. A full render is roughly 20 frames/s, so a 100 s video takes about
two and a half minutes — too long to use as your feedback loop.

Other flags: `--frames-only` to stop before encoding, `--keep-frames` to inspect them, `--crf` for
quality. The `adelay` always equals the intro length, which the engine exposes as `window.INTRO`.
Verify the result with `ffprobe`: duration, 1080×1920 or 1920×1080, and an audio stream present.

---

## 9. Wiring the video into the demo page

**The transcript-driven route does this for you** — `build-voice-video.mjs` writes the whole block
below except `summary`, and is safe to re-run. Read on when you took the recorded-call route, or
when you want to understand or hand-edit what it wrote.

Copy the finished MP4 into `axl-sessions/AXL-<customer>/poc-demo/assets/` and add a `voice` block to
`recording.json`:

```json
"voice": {
  "videoFile": "assets/call-demo.mp4",
  "poster": "assets/call-poster.png",
  "format": "9x16",
  "title": "Inbound call — reschedule and benefits question",
  "summary": "One call: two intents, one interruption, resolved without a transfer.",
  "phoneNumber": "+1 555 010 0199",
  "agentName": "Agentic Virtual Agent",
  "callerName": "Patient",
  "capabilities": [
    { "at": 12, "title": "Multiple inputs in one sentence", "subtitle": "Caller packs three requests into one turn" },
    { "at": 48, "title": "Guardrails", "subtitle": "Verifies identity before reading the record" }
  ],
  "outcomes": [
    { "label": "Requests resolved", "value": "3/3" },
    { "label": "Transfers to a human", "value": "0" }
  ],
  "transcript": [
    { "at": 0, "speaker": "agent", "text": "Thanks for calling. How can I help?" },
    { "at": 6, "speaker": "caller", "text": "I need to move my appointment." }
  ]
}
```

- `format` is `9x16` (vertical, default) or `16x9` (horizontal) and only controls how the player is
  sized on the page.
- `capabilities[].at` and `transcript[].at` are seconds **into the finished MP4** (including the 6 s
  intro) — not original-audio seconds. They become clickable seek points.
- `poster` is optional; without it the browser shows the first frame. A poster frame makes the idle
  page look intentional, so grab one: `ffmpeg -y -ss 3 -i final.mp4 -frames:v 1 assets/call-poster.png`.
  `render-call.mjs` already writes one next to the MP4.
- Keep the transcript lines reasonably short — they render as a scrolling, auto-following rail beside
  the video.

Then generate with `--voice` or `--both`. The MP4 is **linked, not inlined**, so `demo.html` must
travel with its `assets/` folder. Use `--embed-video` only for short clips under about 10 MB.

---

## 10. Delivering

Report briefly:

- file name, format and duration
- what the video shows, grouped by capability, with the concrete moments from this call
- every judgment call made (speaker attribution in quick exchanges, inferred words, masking or no
  masking, logo softness, the agent's name in the audio versus on screen)
- the obvious next steps: the other aspect ratio, a 60–90 s social cut, or a music bed

### Variants users often ask for

| Request | How to do it |
|---|---|
| Shorter cut | Pick the scenes that show each capability once, cut the audio at turn boundaries, rebuild the time map. |
| Remove the bleeps / show the brand | Rebuild the audio from the original without masks (reuse the same time map) and restore names in captions and cards. |
| Other aspect ratio | `build-voice-video.mjs --format 16x9 --replan`. The cached audio is reused, so only the render costs time. |
| Reword one AVA reply | Fix it in `recording.json`, re-run `build-voice-video.mjs`. Only that line is re-synthesized. |
| Different voices | `--agent-voice` / `--caller-voice`. This does re-synthesize everything. |
| New customer, same look | New transcript, scenes and logo; keep the engine, palette, ending and CTA unchanged. |
