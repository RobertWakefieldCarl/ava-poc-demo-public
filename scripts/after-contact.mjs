#!/usr/bin/env node
'use strict';

/**
 * after-contact.mjs — the supervisor's view of a finished interaction, for the demo page.
 *
 * Genesys writes an AI summary and a wrap-up code through After Contact at the end of every
 * interaction, contained or escalated. This builds the `afterContact` block of recording.json
 * from whatever the AXL session already has:
 *
 *   summary-setting.json   the configured custom summary — participant labels, the three
 *                          predefined insights, and the custom entities a supervisor sees
 *   wrap-up-codes.json     the codes actually created in the org for this customer
 *
 * Both live in the session folder one level above poc-demo/, so a demo can show the customer's
 * real configuration rather than invented field names.
 *
 * What it cannot do is fetch the generated summary *text*. The platform's preview endpoint
 * returns 200 with an empty body and delivers the result on a user-scoped notification topic;
 * the harness authenticates with client credentials, which has no user context. So `scaffold`
 * leaves the prose empty for an author to write, and the page labels it as illustrative.
 *
 *   scaffold   write an afterContact skeleton into recording.json, with the real entity labels
 *   codes      list the wrap-up codes available in this session's org artifacts
 *   check      verify the block against those artifacts before the demo is generated
 */

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `
Usage: node after-contact.mjs <scaffold|codes|check> --recording <recording.json> [options]

  --recording <file>   The demo recording (required)
  --session <dir>      Session folder holding summary-setting.json and wrap-up-codes.json
                       (default: the parent of the recording's folder)
  --code <name>        Wrap-up code to use, exactly as named in the org
  --handoff            Mark the interaction as transferred to a person
  --queue <name>       Queue it was transferred to (with --handoff)
  --force              Overwrite an existing afterContact block
`;

function parseArgs(argv) {
  const out = { cmd: argv[2] };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--code') out.code = argv[++i];
    else if (a === '--queue') out.queue = argv[++i];
    else if (a === '--handoff') out.handoff = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`after-contact: ${msg}`);
  process.exit(code);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Wrap-up code files come from two generators, so accept either shape. */
function loadCodes(sessionDir) {
  for (const name of ['wrap-up-codes.json', 'wrapup-codes.json', 'wrapup-codes-created.json']) {
    const f = path.join(sessionDir, name);
    if (!fs.existsSync(f)) continue;
    const raw = readJson(f);
    const list = Array.isArray(raw) ? raw : raw.codes || raw.wrapUpCodes || [];
    return { file: f, codes: list.map((c) => String(c.name || c.Name || '').trim()).filter(Boolean) };
  }
  return { file: null, codes: [] };
}

function loadSetting(sessionDir) {
  const f = path.join(sessionDir, 'summary-setting.json');
  return fs.existsSync(f) ? { file: f, setting: readJson(f) } : { file: null, setting: null };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.cmd || !args.recording) {
    console.log(USAGE.trim());
    process.exit(args.recording && args.cmd ? 0 : 1);
  }

  const recPath = path.resolve(args.recording);
  if (!fs.existsSync(recPath)) fail(`no recording at ${recPath}`, 66);
  const sessionDir = args.session ? path.resolve(args.session) : path.dirname(path.dirname(recPath));

  const { file: codesFile, codes } = loadCodes(sessionDir);
  const { file: settingFile, setting } = loadSetting(sessionDir);

  if (args.cmd === 'codes') {
    if (!codes.length) {
      fail(`no wrap-up codes found in ${sessionDir}.\n` +
        '  Run the ava-wrap-up-codes skill for this session first, or pass --session.', 66);
    }
    console.log(`after-contact: ${codes.length} wrap-up codes in ${path.basename(codesFile)}`);
    for (const c of codes) console.log(`  ${c}`);
    return;
  }

  const rec = readJson(recPath);

  if (args.cmd === 'scaffold') {
    if (rec.afterContact && !args.force) {
      fail('recording.json already has an afterContact block. Pass --force to replace it.', 65);
    }
    if (args.code && codes.length && !codes.includes(args.code)) {
      fail(`"${args.code}" is not a wrap-up code in this org.\n` +
        `  Run: node after-contact.mjs codes --recording "${recPath}"`, 65);
    }
    const entities = ((setting && setting.customEntities) || []).map((e) => ({
      label: e.label,
      value: '',
    }));
    rec.afterContact = {
      _comment: [
        'What a supervisor sees after the interaction. Genesys writes a summary and a wrap-up',
        'code on every interaction, not only escalations. The generated summary text cannot be',
        'read back through the harness, so write it here; the page labels it as illustrative.',
        'Entity labels come from the org summary setting — fill the values from the conversation.',
      ],
      source: args.code && codes.includes(args.code) ? 'org' : 'authored',
      disposition: args.handoff ? 'handoff' : 'contained',
      ...(args.handoff
        ? { handoff: { queue: args.queue || '', reason: '', agentSees: [{ label: '', value: '' }] } }
        : {}),
      wrapUpCode: {
        name: args.code || '',
        source: args.code && codes.includes(args.code) ? 'org' : 'authored',
      },
      summary: {
        settingName: (setting && setting.name) || '',
        text: '',
        reasonForCall: '',
        resolution: '',
        actionItems: [],
        entities,
      },
    };
    fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`after-contact: scaffolded into ${recPath}`);
    console.log(`  summary setting  ${settingFile ? path.basename(settingFile) : 'not found — labels left empty'}`);
    console.log(`  entities         ${entities.length}${entities.length ? ` (${entities.map((e) => e.label).join(', ')})` : ''}`);
    console.log(`  wrap-up codes    ${codes.length} available${codesFile ? ` in ${path.basename(codesFile)}` : ''}`);
    console.log('  Fill in text, insights and entity values, then run `check`.');
    return;
  }

  if (args.cmd === 'check') {
    const ac = rec.afterContact;
    if (!ac) fail('recording.json has no afterContact block. Run `scaffold` first.', 66);
    const problems = [];
    const warn = [];

    const name = ac.wrapUpCode && ac.wrapUpCode.name;
    if (!name) problems.push('wrapUpCode.name is empty');
    else if (codes.length && !codes.includes(name)) {
      problems.push(`wrap-up code "${name}" is not in this org's list (${path.basename(codesFile)})`);
    }
    if (ac.wrapUpCode && ac.wrapUpCode.source === 'org' && codes.length && !codes.includes(name)) {
      problems.push('wrapUpCode.source says "org" but the code is not in the org list');
    }

    const s = ac.summary || {};
    if (!s.text) warn.push('summary.text is empty — the panel will omit the narrative');
    if (!s.reasonForCall) warn.push('summary.reasonForCall is empty');
    if (!s.resolution) warn.push('summary.resolution is empty');

    const defined = new Set(((setting && setting.customEntities) || []).map((e) => e.label));
    for (const e of s.entities || []) {
      if (defined.size && !defined.has(e.label)) {
        problems.push(`entity "${e.label}" is not defined in the org summary setting`);
      }
      if (!e.value) warn.push(`entity "${e.label}" has no value`);
    }

    if (ac.disposition === 'handoff' && !(ac.handoff && ac.handoff.queue)) {
      warn.push('disposition is handoff but no queue is named');
    }
    // A demo that claims a transfer the conversation never made is the failure mode here.
    const spoke = (rec.messages || []).some((m) =>
      m.role === 'agent' && /connect you|transfer you|pass you|associate|representative|live agent/i.test(m.text || '')
    );
    if (ac.disposition === 'handoff' && !spoke) {
      problems.push('disposition is handoff, but no agent turn offers or performs one');
    }
    if (ac.disposition === 'contained' && spoke) {
      warn.push('an agent turn mentions a person — confirm the call really was contained');
    }

    for (const p of problems) console.error(`  problem  ${p}`);
    for (const w of warn) console.log(`  note     ${w}`);
    if (problems.length) {
      console.error(`after-contact: ${problems.length} problem(s) — fix before generating.`);
      process.exit(65);
    }
    console.log(`after-contact: ok — ${ac.disposition}, code "${name}", ` +
      `${(s.entities || []).length} entities, source "${ac.source}".`);
    return;
  }

  fail(`unknown command "${args.cmd}". Use scaffold, codes or check.`, 64);
}

main();
