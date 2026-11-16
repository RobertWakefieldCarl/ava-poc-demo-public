# Showing the Navigator in front of the AVA

In production an AVA rarely answers the published number itself. An Architect bot flow — a
**Navigator** — answers, asks what the caller needs, classifies the intent and routes them to the
right assistant. Demos that start at the AVA skip that step, and the customer's first question in
the room is almost always *"how did the call get to it?"*

This skill can show the routing step in both channels. It is **opt-in**: Step 0 asks, and nothing
renders unless the recording actually contains Navigator turns.

## 1. When to include it

Include it when the org has a real Navigator flow and the AVA is one of several destinations
behind it — that is the whole point being made, and it is the part of the architecture a buyer
recognises. Leave it out when the AVA is the only assistant, when the demo is short and the
routing step would eat a third of it, or when no such flow exists in the org yet. Standing one up
is [ava-navigator](../../ava-navigator/SKILL.md)'s job, not this skill's.

Never show a flow the org cannot demonstrate live. The `botFlow` name must be real — find it with
`list_resources(resourceType: 'botflow', name: '<search>')`.

## 2. The recording

Two pieces: a top-level `navigator` block, and `role: "navigator"` turns at the front of
`messages`.

```json
"navigator": {
  "name": "Utah DPS Navigator",
  "botFlow": "UT DPS Inbound Navigator",
  "intent": "New driver license",
  "routedTo": "Utah DLD Assistant"
},
"useCases": [
  {
    "id": "routing",
    "title": "Reach the right assistant",
    "summary": "One published number. The Navigator classifies the intent and routes to the DLD assistant.",
    "mockData": [
      { "label": "Published number", "value": "+1 801 965 4437" },
      { "label": "Bot flow", "value": "UT DPS Inbound Navigator" },
      { "label": "Destinations", "value": "4 assistants" }
    ]
  }
],
"messages": [
  {
    "useCaseId": "routing",
    "role": "navigator",
    "text": "Thanks for calling the Utah Department of Public Safety. In a few words, tell me what you need today."
  },
  {
    "useCaseId": "routing",
    "role": "customer",
    "text": "I just moved here from Colorado and I need to get a Utah driver license."
  }
]
```

| Field | Meaning |
|-------|---------|
| `name` | What the flow is called on screen and in the transcript. Defaults to `Navigator` |
| `botFlow` | The Architect flow's real name in the org. Shown in the side rail, not spoken |
| `intentCategory` | The Customer Intent category behind the flow. Optional, for the rail |
| `intent` | The intent the flow matched. Omit it and the routing line just names the destination |
| `routedTo` | Where it routed. Defaults to the AVA's name |

## 2a. Routing to more than one AVA

A caller can come back to the front door mid-call — ask where an order is, then order ink. Replace
`intent`/`routedTo` with a `routes` array, one entry per hop, in the order the call takes them:

```json
"navigator": {
  "name": "HP Front Door",
  "botFlow": "AXL - Retail Tech - Navigator Bot",
  "intentCategory": "AXL Retail Tech Front Door",
  "routes": [
    { "intent": "Check Order Status", "routedTo": "HP Order Assistant" },
    { "intent": "Reorder Supplies or Replacement Items", "routedTo": "HP Supplies Assistant" }
  ]
}
```

A hop is a **run of consecutive `navigator` turns**, so a flow that says two things before routing
is still one hop. Hop *n* takes `routes[n]`.

Then name the AVA on each agent turn, because otherwise half the conversation is attributed to the
wrong assistant:

```json
{ "useCaseId": "order-status", "role": "agent", "speaker": "HP Order Assistant", "text": "…" },
{ "useCaseId": "supplies",     "role": "agent", "speaker": "HP Supplies Assistant", "text": "…" }
```

`speaker` on an agent turn is **only** read when more than one distinct AVA speaks. A single-AVA
demo leaves it out and keeps the cleaner untagged bubbles. List the AVAs in a top-level `avas`
array as well, so the transcript header names both with their versions and agent IDs:

```json
"avas": [
  { "name": "HP Order Assistant", "agentId": "669bcb12-…", "version": "7.0" },
  { "name": "HP Supplies Assistant", "agentId": "45355117-…", "version": "6.0" }
]
```

Each AVA still has to be **recorded separately** through Cicero — one session per AVA, because
that is how the real call works. Stitch the two transcripts together in `messages` in the order
the caller experienced them.

Write only what the flow *says*. The routing decision itself — "Intent: X · Routed to Y" — is
rendered by the generator from this block, so writing it as a Navigator line duplicates it.

Give the Navigator turns their own use case. Without one the chat rail opens mid-chapter and the
video's first capability chip is missing.

`navigator` turns are **not** recorded through Cicero, because Cicero drives the AVA rather than
the flow in front of it. They are authored, like the After Contact summary — which is fine
provided they say what the real flow says. Read the flow's prompt in Architect and use its words.

## 3. What renders

**Digital.** The Navigator gets its own named, indigo-tinted bubble, visually distinct from both
the AVA and a live agent. The caller answers in a normal bubble. Then a centred system pill —
`Intent: New driver license · Routed to Utah DLD Assistant` — marks the hand-over, after which
every remaining turn is the AVA's. `transcript.md` attributes the lines to the Navigator by name,
and names every AVA and the front door in its header. With more than one AVA, each agent bubble
carries the assistant's name in the brand colour.

**Voice.** The Navigator is synthesized in **its own voice**, defaulting to `Daniel` and
overridable with `voice.tts.navigatorVoice` or `--navigator-voice`. Hearing one voice throughout
would hide the hand-over entirely, so the resolver refuses to reuse the agent, caller or live-agent
voice. On screen it gets a purple speaker tag (`UTAH DPS NAVIGATOR · ROUTING`), a purple waveform,
a routing card showing what it heard and where it sent the caller, an **Intent routing** capability
banner, and its name on the pre-call "Answering…" card. `synth-call.mjs` also adds the hand-over
pause before the AVA's first words, so the transition sounds like a connection being made rather
than a cut. Each hop gets its own card and banner, and the speaker tag names whichever AVA is
talking.

The contact sheet renders a `voice-navigator.jpg` frame whenever the recording has Navigator
turns, so the routing moment can be checked without a full render.

## 4. Cost

Two extra lines of speech, both cached after the first run, and roughly fifteen seconds of video.
Everything else is layout. Re-running `plan-scenes.mjs --force` is what picks the step up on an
existing build; without `--force` it keeps the hand-edited `scenes.json` and the Navigator card
never appears.
