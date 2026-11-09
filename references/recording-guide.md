# Recording guide

How to choose the use cases, find the mock values that make them work, and drive the live AVA.

## Finding the use cases

Read, in order of authority:

1. **`.ava-lifecycle/<slug>/design-artifact.json`** — `tools[]` is the real capability list. Each
   DataAction or Knowledge tool is a candidate use case; `role` states what is in and out of scope.
2. **`.ava-lifecycle/<slug>/test-cases/*.json`** — scenarios the test skill already authored. Their
   `goal` and `start_context` are ready-made demo storylines with known-good inputs.
3. **AXL session material** — `axl-sessions/AXL-<customer>/`: `spec-artifact.md` and
   `mock-data.html` (older sessions call it `test-data.html`) describe the use cases the customer
   actually asked for. These outrank anything inferred from the config. This is also where the
   demo is written, as `<session>/poc-demo/`.

Aim for **4–7 use cases**. Fewer looks thin; more makes the replay too long to present. Cover at
least one authenticated lookup, one knowledge question, and one non-happy path.

## Finding the mock data

The conversation only works if the inputs you speak resolve against the mock Data Actions. Sources,
best first:

| Source | What it gives you |
|--------|-------------------|
| `axl-sessions/AXL-<customer>/mock-data.html` (or `test-data.html` in older sessions) | The curated demo dataset — account numbers, orders, members, and deliberate trap cases |
| `design-artifact.json` → tool `targetId` → `get_data_action_schema` | Input and output field names and types |
| The DataAction's `mock_responses[]` and `default_mock` | The exact input values that return each canned response |
| `test-cases/*.json` → `start_context` and `reference_trajectory` | Inputs already proven to work |

Rules:

- **Use a value that hits a declared `mock_responses` case**, not one that falls through to
  `default_mock` — unless demonstrating the fallback is the point.
- If a use case needs a not-found or error path, find the mock case that returns the error. Error
  mocks return only an HTTP status, so the demo value is the AVA's **recovery wording**, not the
  error text.
- Record 2–4 `mockData` rows per use case for the demo's side rail. Pick what the audience needs to
  follow along (member ID, plan, order number, balance) — not internal tokens.

## Driving the conversation

One `cicero_start_session` for the whole arc, so context carries between use cases and the demo
shows the AVA remembering what it was told.

For each customer turn:

1. Write the turn as a **real person** would: lowercase, contractions, occasional imprecision. Avoid
   phrasing that reads like a test script ("I would like to query my account balance").
2. Call `cicero_send_message` with the text and the previous `turn_id`.
3. Record from the response: the agent text **verbatim**, every tool call (name, input, output,
   status), and whether the turn was terminal.
4. Carry the new `turn_id` forward.

Adapt to what the AVA actually says. If it asks for a member ID you did not plan to give yet, give
it — a demo where the agent has to repeat itself looks worse than a reordered script.

### Making it feel real, not staged

- Let the customer be slightly vague first ("something's wrong with my last order") and let the AVA
  do the clarifying. That showcases the agent instead of the script.
- Include one correction mid-conversation ("sorry, it's 44821 not 44812"). Recovery is one of the
  strongest things an agentic VA demonstrates.
- Chain intents conversationally — "and can you also…" — rather than restarting each topic cold.
- Close with the customer confirming they are done, so the AVA's farewell event fires naturally.

### When the AVA behaves badly

Stop and decide with the facilitator:

| Situation | Action |
|-----------|--------|
| Wrong or missing tool call | Fix the AVA via [ava-design](../ava-design/SKILL.md) → re-publish → re-record |
| Clumsy wording | Note it; re-record after a design fix if it undermines the demo |
| Mock returns the wrong record | Fix the mock input value and re-run that stretch |
| Guardrail fires unexpectedly | Worth keeping **if** the demo is about safety; otherwise rephrase the turn |

Never paper over it by writing the reply you wanted. The transcript must match what the live AVA
does, because the customer will try it themselves.

## Mapping turns into recording.json

### Channel

Set `ava.channel` to `voice`, `chat` or `messaging` before generating. The demo renders as a chat
widget whatever the AVA is — a transcript is the only honest way to put a phone call on a page — so
the wording has to carry the truth that the picture cannot. The generator derives the transcript's
channel line, the page header, and the widget's default title, subtitle and input placeholder from
it. A voice AVA gets "Recorded phone call ... shown here as a transcript" and a "Caller speaking…"
input; a chat AVA gets the web-chat wording.

Override any of it through `widget` when the customer uses their own language for the phone line.
Never correct the generated files by hand: a post-processing patch silently stops matching the next
time the generator changes, and the person after you will not know it ran.

### Turns

- `role` is `customer`, `agent`, or `system`. Use `system` sparingly, for framing notes that should
  appear as a centered chip in the chat (for example "Customer returns two days later").
- Attach `actions[]` to the **agent message the tool calls produced**. They animate before that
  bubble, which is what the audience expects: the AVA works, then answers.
- `actions[].label` is a short result summary shown on the resolved chip ("verified", "3 orders
  found"). Keep it under about 20 characters.
- Mask secrets in `actions[].output` — render a token as `"***"`.
- Set `status` to something other than `"ok"` for a failed call; the chip renders in red, which is
  exactly what you want when demonstrating error handling.
- `note` appears in `transcript.md` only — use it for presenter cues.
