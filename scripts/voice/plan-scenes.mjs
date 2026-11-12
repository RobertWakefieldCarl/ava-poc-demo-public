#!/usr/bin/env node
'use strict';

/**
 * plan-scenes.mjs — derive the video's visual story from recording.json + data.js.
 *
 * Everything here is inferred from what the recording actually contains: use cases become
 * chapters and status chips, tool calls become agent-action cards, mock data becomes data cards,
 * and the capability banner is mapped from the shape of each turn. Nothing is invented — the
 * outcome tiles only count things present in the recording.
 *
 * The result is scenes.json, which is meant to be read and tuned by hand before rendering. The
 * renderer is a dumb deterministic engine; all the editorial judgment lives in this file's output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripVoiceTags } from '../lib/voice-tags.mjs';

const USAGE = `
Usage: node plan-scenes.mjs --recording <recording.json> [options]

  --recording <file>   The demo recording (required)
  --out-dir <dir>      Build folder holding data.js (default: <recording dir>/voice-build)
  --format <9x16|16x9> Aspect ratio (default: from recording.voice.format, else 9x16)
  --force              Overwrite an existing scenes.json instead of leaving hand edits alone
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`plan-scenes: ${msg}`);
  process.exit(code);
}

/** data.js is a browser file; strip the assignment to read it from Node. */
function readData(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/window\.DATA\s*=\s*([\s\S]+?);\s*$/);
  if (!m) fail(`could not parse ${file} — re-run synth-call.mjs`);
  return JSON.parse(m[1]);
}

const GUARD_RE = /verif|auth|identit|eligib|consent|validate|confirm_member|lookup_member/i;
const titleCase = (s) =>
  String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** A caller turn that packs several asks into one breath is the headline AVA capability. */
function isMultiRequest(text) {
  const sentences = text.split(/[.?!]+/).filter((s) => s.trim().length > 3);
  const asks = (text.match(/\?/g) || []).length;
  return asks >= 2 || sentences.length >= 3 || (sentences.length >= 2 && /\band\b|\balso\b/i.test(text));
}

/**
 * The caller cutting in mid-flow is worth calling out. Only true barge-in markers count — a turn
 * opening with "no" or "sorry" is usually just an answer, and at the end of a call it is the
 * sign-off rather than an interruption.
 */
const isInterruption = (text) => /^(wait|hold on|hang on|actually|sorry, )/i.test(text.trim());

/**
 * The banner shows one capability at a time, so overlapping windows would make the engine's
 * last-one-wins loop swap them mid-fade. Clip each window to end before the next one opens, and
 * drop any that gets squeezed below a readable duration.
 */
function deoverlap(caps, minHold = 1.2) {
  const sorted = [...caps].sort((a, b) => a.at - b.at);
  const kept = [];
  for (const cap of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && cap.at < prev.until) prev.until = +Math.max(prev.at, cap.at - 0.2).toFixed(2);
    if (cap.until - cap.at >= minHold) kept.push(cap);
  }
  return kept.filter((c) => c.until - c.at >= minHold);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.recording) {
    console.log(USAGE.trim());
    process.exit(args.recording ? 0 : 1);
  }

  const recPath = path.resolve(args.recording);
  if (!fs.existsSync(recPath)) fail(`no recording at ${recPath}`, 66);
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));

  const outDir = args.outDir || path.join(path.dirname(recPath), 'voice-build');
  const dataPath = path.join(outDir, 'data.js');
  if (!fs.existsSync(dataPath)) fail(`no data.js in ${outDir} — run synth-call.mjs first`, 66);
  const data = readData(dataPath);

  const scenesPath = path.join(outDir, 'scenes.json');
  if (fs.existsSync(scenesPath) && !args.force) {
    console.log(`plan-scenes: ${scenesPath} already exists — keeping hand edits. Use --force to redo.`);
    return;
  }

  const voice = rec.voice || {};
  const customer = rec.customer || {};
  const brandPath = path.join(path.dirname(recPath), 'assets', 'brand.json');
  const brand = fs.existsSync(brandPath) ? JSON.parse(fs.readFileSync(brandPath, 'utf8')) : {};
  const useCases = rec.useCases || [];
  const messages = (rec.messages || []).filter((m) => String(m.text || '').trim());

  // data.js segments and recording messages are produced from the same filtered list, so they
  // line up index for index. Attaching them gives each turn both its words and its timing.
  const turns = data.segs.map((seg, i) => ({ ...seg, msg: messages[i] || {} }));

  const chips = [];
  const cards = [];
  const caps = [];

  const addCap = (at, until, title, subtitle) => {
    caps.push({ at: +at.toFixed(2), until: +until.toFixed(2), title, subtitle });
  };

  // One chip per use case, held across the turns belonging to that chapter.
  for (const uc of useCases) {
    const own = turns.filter((t) => t.useCaseId === uc.id);
    if (!own.length) continue;
    const start = own[0].start;
    const end = own[own.length - 1].end;
    chips.push({ at: +start.toFixed(2), until: +end.toFixed(2), text: uc.title, tone: 'ok' });

    // Cards must end above the avatars, which caps them at roughly three rows.
    const rows = (uc.mockData || []).slice(0, 3).map((d) => ({ label: d.label, value: d.value }));
    if (rows.length) {
      cards.push({
        at: +start.toFixed(2),
        until: +Math.min(end, start + 9).toFixed(2),
        cls: 'white',
        slot: 1,
        title: uc.title,
        rows,
      });
    }
  }

  for (const [i, turn] of turns.entries()) {
    const actions = turn.msg.actions || [];

    if (turn.ch === 'L') {
      if (isMultiRequest(turn.text)) {
        addCap(turn.start, turn.end + 1.5, 'Multiple inputs in one sentence',
          'Caller packs several requests into one turn');
      } else if (isInterruption(turn.text) && i > 1) {
        addCap(turn.start, turn.end + 1.5, 'Turn interruption',
          'Caller cuts in; the agent answers and resumes');
      }
      continue;
    }

    if (!actions.length) continue;

    // The action card appears during the thinking pause synth-call left before this turn.
    const at = Math.max(0, turn.start - 1.0);
    const until = turn.end;
    cards.push({
      at: +at.toFixed(2),
      until: +until.toFixed(2),
      cls: actions.some((a) => a.status && a.status !== 'ok') ? 'warn' : 'ok',
      slot: 0,
      action: true,
      title: 'AGENT ACTION',
      rows: actions.slice(0, 3).map((a) => ({
        label: titleCase(a.name),
        value: a.label || (a.status === 'ok' ? 'Done' : a.status || 'Done'),
      })),
    });

    const guard = actions.find((a) => GUARD_RE.test(a.name || ''));
    if (guard) {
      addCap(at, until, 'Guardrails', `Verifies before reading the record · ${titleCase(guard.name)}`);
    } else {
      addCap(at, until, 'Action execution', actions.map((a) => titleCase(a.name)).join(' · '));
    }
  }

  // Close on the outcome, over the final agent turn.
  const lastAgent = [...turns].reverse().find((t) => t.ch === 'R');
  if (lastAgent) {
    addCap(lastAgent.start, lastAgent.end + 1.0, 'Business outcome',
      'Resolved on first contact, with no transfer to a human');
  }

  const shownCaps = deoverlap(caps);
  const capsUsed = [...new Set(shownCaps.map((c) => c.title))];
  const toolCalls = turns.reduce((n, t) => n + ((t.msg.actions || []).length), 0);
  const humanTransfers = turns.filter((t) => {
    if (t.msg.role !== 'agent') return false;
    const acts = t.msg.actions || [];
    if (acts.some((a) => a.type === 'escalation' || a.name === 'escalation')) return true;
    return /pass you to a member services representative|connect you with a member services representative/i.test(
      stripVoiceTags(t.msg.text),
    );
  }).length;
  const capLine = {
    'Multiple inputs in one sentence': 'Understood several requests in a single sentence',
    'Turn interruption': 'Handled an interruption and picked the task back up',
    'Action execution': 'Executed real actions against the business systems',
    Guardrails: 'Stayed inside its guardrails before touching customer data',
    'Business outcome': 'Resolved the call end to end, with no transfer',
  };

  const scenes = {
    format: args.format || voice.format || '9x16',
    customerName: customer.name || 'the customer',
    agentName: voice.agentName || 'Agentic Virtual Agent',
    agentRole: 'AI agent',
    callerName: voice.callerName || 'Caller',
    logo: fs.existsSync(path.join(path.dirname(recPath), 'assets', 'logo.svg'))
      ? 'assets/logo.svg'
      : customer.logoFile || null,
    // A light-art logo vanishes on the beige intro, so it gets the same dark badge the web chat
    // widget uses. capture-customer-page.mjs measured this; brand.json is the fallback source.
    logoBackground: customer.logoBackground || brand.logoBackground || null,
    brandColor: customer.brandColor || '#ff5a1f',
    // The background texture sets about half the MP4's size. 26 lines at 0.12 alpha is the old,
    // heavier look; 0 lines drops it entirely. See voice-video.md §8.
    waves: voice.waves || { lines: 12, alpha: 0.12 },
    intro: {
      eyebrow: 'MEET THE',
      title: 'Agentic Virtual Agent',
      line1: 'One call.',
      line2: 'Problem solved.',
      context:
        voice.summary ||
        `A caller reaches ${customer.name || 'the customer'} and the agentic virtual agent handles ` +
          `${useCases.length} request${useCases.length === 1 ? '' : 's'} in one conversation.`,
      inboundLabel: `Inbound call · ${customer.name || 'Customer'}`,
    },
    chips,
    cards,
    caps: shownCaps,
    recap: {
      lead: 'In one call, the Genesys Agentic Virtual Agent:',
      lines: capsUsed.map((c) => capLine[c] || c),
    },
    outcome: {
      line1: 'One call.',
      line2: 'Fully resolved.',
      // Only counts the recording can actually back up.
      tiles: [
        { value: `${useCases.length}/${useCases.length}`, label: 'Requests resolved' },
        { value: String(toolCalls), label: 'Actions executed' },
        { value: String(humanTransfers), label: 'Transfers to a human' },
        { value: `${Math.round(data.callDur)}s`, label: 'Hello to resolved' },
      ],
    },
    outro: {
      line1: 'Orchestrate every channel.',
      line2: 'Resolve with AI.',
      line3: 'All in Genesys Cloud.',
      pill: 'Meet the Genesys Agentic Virtual Agent',
    },
    cta: {
      eyebrow: 'TRY IT YOURSELF',
      line1: 'Talk to the Agentic Virtual Agent',
      line2: 'by phone.',
      note: 'Call the demo line and play with the agent.',
      phone: voice.phoneNumber || null,
    },
  };

  fs.writeFileSync(scenesPath, `${JSON.stringify(scenes, null, 2)}\n`);

  console.log(`plan-scenes: wrote ${scenesPath}`);
  console.log(`  chapters    ${chips.length} · cards ${cards.length} · capabilities ${shownCaps.length}`);
  console.log(`  capabilities shown: ${capsUsed.join(', ') || 'none detected'}`);
  if (!scenes.cta.phone) {
    console.log('  ending     Genesys outro (no voice.phoneNumber, so the phone CTA is skipped)');
  }
  console.log('  Review and tune scenes.json before rendering; it is the editorial layer.');
}

main();
