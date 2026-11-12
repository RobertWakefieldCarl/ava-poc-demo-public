// Cases taken from real recordings, plus the bracketed content that must survive untouched.
import { stripVoiceTags, hasVoiceTags } from './voice-tags.mjs';

const STRIP = [
  ['[calm] You have two open requirements to address.', 'leading tag'],
  ["[concerned] The Nephi office isn't open on Wednesdays. [reassuring] Springville is open.", 'two inline'],
  ['[calm and empathetic] I understand.', 'three-word tag'],
  ['Thanks for calling. [relieved]', 'trailing tag'],
  ['[warmly]Hi there', 'no space after tag'],
];

const KEEP = [
  ['Your claim [1] was approved.', 'digit'],
  ['We show it as [REDACTED] here.', 'capitals'],
  ['Ask for [Dr Chen] at reception.', 'proper noun'],
  ['Details at [see dld.utah.gov] online.', 'punctuation inside'],
  ['No brackets at all here.', 'plain text'],
];

// Known limitation, pinned so it is a decision rather than a surprise: a bracketed lowercase word
// that is genuinely content is indistinguishable from a tag and gets stripped. Accepted because
// most real tags are a single lowercase word, so requiring a known-tag vocabulary would leak the
// common case, and brackets around spoken content effectively do not occur in AVA replies.
const KNOWN_LIMITATION = [['Bring [two] documents.', 'Bring documents.']];

let failures = 0;
for (const [input, label] of STRIP) {
  const out = stripVoiceTags(input);
  const ok = !hasVoiceTags(out) && out.length > 0;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  strip ${label.padEnd(30)} -> ${JSON.stringify(out)}`);
}
for (const [input, label] of KEEP) {
  const out = stripVoiceTags(input);
  const ok = out === input;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  keep  ${label.padEnd(30)} -> ${JSON.stringify(out)}`);
}

for (const [input, expected] of KNOWN_LIMITATION) {
  const out = stripVoiceTags(input);
  const ok = out === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  limit ${'bracketed content word'.padEnd(30)} -> ${JSON.stringify(out)}`);
}

const repeats = [1, 2, 3].map(() => hasVoiceTags('[calm] hi')).join(',');
const stable = repeats === 'true,true,true';
if (!stable) failures += 1;
console.log(`${stable ? '  ok  ' : '  FAIL'}  hasVoiceTags stable across calls -> ${repeats}`);
console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all cases pass'}`);
process.exit(failures ? 1 : 0);
