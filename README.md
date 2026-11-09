# ava-poc-demo

A [Cursor](https://cursor.com) Agent Skill that turns a Genesys Cloud **Agentic Virtual Agent**
into a proof-of-concept demo you can hand to a customer:

- a **web-chat demo** rendered over a screenshot of the customer's own site, with their logo and
  brand colours, playing back a real recorded conversation with typing, tool-call chips and a
  mock-data rail
- a **voice-channel MP4** built from that same transcript — synthesized speech over an animated
  "live call" screen with captions, action cards, capability callouts and a branded ending
- a **transcript** and a zipped bundle ready to send

Both channels come from one recorded conversation, so they tell the same story.

## What it produces

```
axl-sessions/AXL-<customer>/poc-demo/
  demo.html          self-contained, images inlined
  transcript.md
  recording.json     the recorded conversation and its mock data
  assets/            page backdrop, logo, brand colours, call MP4 + poster
  review/            verification screenshots
  demo.zip           all of the above, written automatically
```

## Install

```bash
git clone https://github.com/RobertWakefieldCarl/ava-poc-demo-public \
  ~/.cursor/skills/ava-poc-demo
```

Then, in Cursor, ask for an AVA POC demo. [`SKILL.md`](SKILL.md) is the entry point and the
workflow the agent follows.

## Requirements

| | |
|---|---|
| Node | 22+ |
| Playwright | Chromium, for page capture, verification and frame rendering |
| ffmpeg | only for the voice channel |
| ElevenLabs API key | only for the voice channel |
| Genesys Cloud | a published AVA, reached through the skill's MCP harness |

The digital channel needs none of the voice prerequisites.

## API keys

Keys are stored in the operating system's keystore — DPAPI on Windows, Keychain on macOS,
libsecret on Linux. Never in this folder, never in a `.env`, never in shell history.

```bash
node scripts/credentials.mjs set elevenlabs     # reads from stdin, input hidden
node scripts/credentials.mjs status             # fingerprint only, never the key
```

`ELEVENLABS_API_KEY` overrides the keystore when set, for CI and one-off runs. Teams who want to
share one key from a private fork should read [`references/distributing.md`](references/distributing.md).

## How the voice video works

```
recording.json ──► synth-call.mjs   speak each turn, lay out the timeline  ──► call-mix.wav + data.js
               ──► plan-scenes.mjs  infer chips, cards, capabilities       ──► scenes.json
               ──► render-call.mjs  deterministic render(t), 30 fps frames ──► call-demo.mp4
```

`scenes.json` is deliberately a hand-editable file: the planner infers the visual story from the
use cases and tool calls, and you tune it before rendering. Always render a contact sheet first:

```bash
node scripts/build-voice-video.mjs --recording <recording.json> --contact-sheet
```

## Notes

- The demo depicts a Genesys AVA on a **mock-up** of the customer's public page. It is not a live
  integration, and the page screenshot stays inside the POC deliverable.
- Every account number, balance and order detail in a demo is mock data from the AVA's mock Data
  Actions, and the page says so.
- The AVA's replies are never edited. A poor reply is a finding to fix in the AVA, not in the
  transcript.
