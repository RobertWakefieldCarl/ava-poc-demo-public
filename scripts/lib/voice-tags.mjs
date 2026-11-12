'use strict';

/**
 * Expressive-TTS markup, removed from anything a human reads.
 *
 * An AVA authored for ElevenLabs v3+ emits inline direction — "[calm] You have two open
 * requirements" — which the voice engine acts on. It is stage direction, not speech, so it must
 * never reach a chat bubble, a caption or a transcript.
 *
 * A recording can carry it two ways, and both have to work:
 *   - `speechText` holds the tagged form and `text` the clean one (the documented split), or
 *   - `text` holds the tagged form and there is no `speechText` (what authors actually do, since
 *     it is what the AVA returned).
 * Stripping at the point of display covers both, so neither convention leaks markup on screen.
 *
 * Matching is structural rather than a fixed vocabulary, so new tags need no code change: one to
 * three lowercase words in square brackets. That deliberately spares bracketed content that
 * belongs to the conversation — "[1]", "[REDACTED]", "[Dr Chen]", "[see dld.utah.gov]" — because
 * each has a digit, a capital or punctuation the pattern does not admit.
 *
 * The accepted cost is that a bracketed lowercase word which is genuinely content would also be
 * removed. A known-tag vocabulary would avoid that, but most real tags are a single lowercase
 * word, so an unlisted one would leak into the demo — the far likelier and more visible failure.
 */
const VOICE_TAG = /\[[a-z]+(?:[ \-'][a-z]+){0,2}\]/g;

/** Strip expressive-TTS tags and tidy the whitespace they leave behind. */
export function stripVoiceTags(text) {
  if (!text) return '';
  return String(text)
    .replace(VOICE_TAG, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

/** True when the text carries markup that should not be shown. Used for reporting, not filtering. */
export function hasVoiceTags(text) {
  // A fresh regex each call: `test` on a /g/ pattern advances lastIndex and would alternate.
  return !!text && new RegExp(VOICE_TAG.source).test(String(text));
}

/**
 * The two forms of one message: what gets spoken, and what gets shown.
 * The spoken form keeps its tags; the shown form never has them.
 */
export function speechAndDisplay(msg) {
  const spoken = String(msg.speechText || msg.text || '').trim();
  const shown = stripVoiceTags(msg.text || msg.speechText || '');
  return { spoken, shown };
}
