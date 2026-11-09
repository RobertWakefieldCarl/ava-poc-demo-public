#!/usr/bin/env node
'use strict';

/**
 * credentials.mjs — store the skill's API keys in the operating system's keystore.
 *
 * The secret is read from stdin, never from a command-line argument, so it stays out of shell
 * history and the process list. Nothing is ever written into the skill folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setSecret, getSecret, clearSecret, backendName, seal, unseal } from './lib/secrets.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sealedPath = (name) => path.join(SKILL_DIR, 'secrets', `${name}.sealed.json`);
/** Set this to bootstrap without an interactive prompt (CI, scripted installs). */
const PASSPHRASE_ENV = 'AVA_POC_DEMO_PASSPHRASE';

/** Secrets this skill knows about, and the environment variable that overrides each. */
const KNOWN = {
  elevenlabs: {
    envVar: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs API key (voice synthesis for the call video)',
  },
};

const USAGE = `
Usage: node credentials.mjs <command> [name]

  set [name]        Store a key. Reads it from stdin; prompts when run interactively.
  status            Show which keys are stored, without revealing them.
  clear [name]      Remove a stored key.

  bootstrap [name]  Install the team's sealed key into this machine's keystore.
                    This is the one command a new team member runs.
  seal [name]       Maintainer only: seal the stored key for distribution.

Names: ${Object.keys(KNOWN).join(', ')}   (default: elevenlabs)

Examples
  node credentials.mjs bootstrap               # new team member, after cloning
  node credentials.mjs set                     # prompts, input hidden
  "sk_..." | node credentials.mjs set          # piped, e.g. from a password manager
  node credentials.mjs status
`;

// Piped stdin can only be drained once, but `seal` asks twice. Buffer the whole stream on the
// first read and hand out one line per call thereafter.
let pipedLines = null;

async function drainStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

/** Read one line from stdin, hiding it when there is a terminal attached. */
async function readSecretLine(prompt) {
  if (!process.stdin.isTTY) {
    if (!pipedLines) pipedLines = await drainStdin();
    return (pipedLines.shift() ?? '').trim();
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Swallow the echoed characters so the key never appears on screen or in a scrollback buffer.
    const onData = () => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); process.stdout.write(prompt); };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Show enough to recognise a key, never enough to use it. */
const fingerprint = (v) => `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`;

/** Must match the digest seal() records, so status can compare without decrypting. */
const createFingerprint = (v) =>
  crypto.createHash('sha256').update(v).digest('hex').slice(0, 12);

async function main() {
  const [command, nameArg] = process.argv.slice(2);
  const name = nameArg || 'elevenlabs';

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE.trim());
    process.exit(command ? 0 : 1);
  }
  if (!KNOWN[name]) {
    console.error(`credentials: unknown key "${name}". Known: ${Object.keys(KNOWN).join(', ')}`);
    process.exit(64);
  }

  if (command === 'status') {
    console.log(`credentials: stored by ${backendName()}`);
    for (const [key, meta] of Object.entries(KNOWN)) {
      const env = process.env[meta.envVar];
      const stored = getSecret(key);
      const where = env
        ? `${meta.envVar} (environment overrides the keystore)`
        : stored
          ? 'keystore'
          : 'not set';
      const value = env || stored;
      console.log(`  ${key.padEnd(12)} ${where}${value ? ` · ${fingerprint(value.trim())}` : ''}`);

      // A sealed key shipped with the skill is the usual way a new machine gets set up.
      const file = sealedPath(key);
      if (fs.existsSync(file)) {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        const same = value && s.fingerprint === createFingerprint(value.trim());
        console.log(
          `  ${''.padEnd(12)} sealed team key available (sealed ${s.sealedAt.slice(0, 10)})` +
            `${value ? (same ? ' — matches the installed key' : ' — DIFFERENT from the installed key') : ''}`
        );
        if (!value) console.log(`  ${''.padEnd(12)} run: node credentials.mjs bootstrap ${key}`);
      } else if (!value) {
        console.log(`  ${''.padEnd(12)} run: node credentials.mjs set ${key}`);
      }
    }
    return;
  }

  if (command === 'bootstrap') {
    const file = sealedPath(name);
    if (!fs.existsSync(file)) {
      console.error(
        `credentials: no sealed key at ${file}.\n` +
          '  This copy of the skill was distributed without a team key — store your own:\n' +
          `    node credentials.mjs set ${name}`
      );
      process.exit(66);
    }
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8'));

    const passphrase =
      process.env[PASSPHRASE_ENV] ||
      (await readSecretLine('Team passphrase (ask whoever sent you this skill): '));
    if (!passphrase) {
      console.error('credentials: no passphrase given — aborted.');
      process.exit(65);
    }

    let value;
    try {
      value = unseal(sealed, passphrase);
    } catch (err) {
      console.error(`credentials: ${err.message}`);
      process.exit(77);
    }

    setSecret(name, value);
    console.log(`credentials: ${name} installed into ${backendName()} · ${fingerprint(value)}`);
    console.log('  The key is now in this machine\'s keystore. You will not need the passphrase again.');
    return;
  }

  if (command === 'seal') {
    const value = getSecret(name) || process.env[KNOWN[name].envVar];
    if (!value) {
      console.error(`credentials: no ${name} key to seal — run "set ${name}" first.`);
      process.exit(66);
    }

    const passphrase = await readSecretLine('Team passphrase to seal under: ');
    if (!passphrase || passphrase.length < 12) {
      console.error(
        'credentials: refusing to seal under a passphrase shorter than 12 characters.\n' +
          '  The sealed file is committed to the repo, so the passphrase is the only thing\n' +
          '  standing between a repo leak and a working key. Use a generated phrase.'
      );
      process.exit(65);
    }
    const confirm = await readSecretLine('Confirm passphrase: ');
    if (confirm !== passphrase) {
      console.error('credentials: passphrases did not match — nothing written.');
      process.exit(65);
    }

    const file = sealedPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(seal(value.trim(), passphrase), null, 2)}\n`);

    console.log(`credentials: sealed ${name} to ${file}`);
    console.log(`  fingerprint ${fingerprint(value.trim())}`);
    console.log('  Commit this file. Send the passphrase separately — never in the repo,');
    console.log('  and never in the same message as the repo link.');
    return;
  }

  if (command === 'clear') {
    clearSecret(name);
    console.log(`credentials: cleared ${name} from ${backendName()}`);
    if (process.env[KNOWN[name].envVar]) {
      console.log(`  note: ${KNOWN[name].envVar} is still set in this shell and will still be used.`);
    }
    return;
  }

  if (command !== 'set') {
    console.error(`credentials: unknown command "${command}"`);
    process.exit(64);
  }

  const value = await readSecretLine(`${KNOWN[name].label}: `);
  if (!value) {
    console.error('credentials: nothing read from stdin — aborted.');
    process.exit(65);
  }

  try {
    setSecret(name, value);
  } catch (err) {
    console.error(`credentials: could not store the key (${err.message})`);
    process.exit(74);
  }

  const check = getSecret(name);
  if (check !== value) {
    console.error('credentials: stored the key but could not read it back — check the keystore.');
    process.exit(74);
  }
  console.log(`credentials: ${name} stored in ${backendName()} · ${fingerprint(value)}`);
}

main();
