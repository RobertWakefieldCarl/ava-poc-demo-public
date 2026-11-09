#!/usr/bin/env node
'use strict';

/**
 * Bundle the finished demo into one zip for handoff.
 *
 * Usage:
 *   node package-demo.mjs --demo-dir <dir>/poc-demo [--out <path>.zip] [--customer-only]
 *
 * demo.html is self-contained, so the zip is for the facilitator's own record and for
 * anyone who wants the transcript and the recording alongside it. --customer-only keeps
 * just the two files a customer should receive (demo.html and transcript.md).
 *
 * Uses the platform's own zip tooling — PowerShell's Compress-Archive on Windows, the
 * `zip` command elsewhere — so there is no dependency to install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { zipDemo, FULL_ITEMS, CUSTOMER_ITEMS } from './lib/zip-demo.mjs';

function parseArgs(argv) {
  const out = { demoDir: null, outFile: null, customerOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo-dir') out.demoDir = path.resolve(argv[++i]);
    else if (a === '--out') out.outFile = path.resolve(argv[++i]);
    else if (a === '--customer-only') out.customerOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `Usage:
  node package-demo.mjs --demo-dir <dir>/poc-demo

Options:
  --out <path.zip>   Output path (default <demo-dir>/demo.zip)
  --customer-only    Bundle only demo.html and transcript.md
`;

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.demoDir) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(path.join(args.demoDir, 'demo.html'))) {
    console.error(`package-demo: no demo.html in ${args.demoDir} — run generate-demo.mjs first`);
    process.exit(66);
  }

  let result;
  try {
    result = zipDemo({
      demoDir: args.demoDir,
      outFile: args.outFile,
      items: args.customerOnly ? CUSTOMER_ITEMS : FULL_ITEMS,
    });
  } catch (err) {
    console.error(
      `package-demo: zip failed (${err.message.split('\n')[0]}).\n` +
        '  A digital-only demo.html is self-contained — send it on its own if packaging' +
        ' is unavailable. A demo with a call video needs the assets/ folder.'
    );
    process.exit(70);
  }

  console.log(`package-demo: wrote ${result.outFile} (${result.sizeKb} KB)`);
  console.log(`  included   ${result.items.join(', ')}`);
  if (result.missing.length) console.log(`  missing    ${result.missing.join(', ')}`);
  if (result.sizeKb > 20000) {
    console.log('  note       over 20 MB — share it as a link rather than an attachment.');
  }
  if (args.customerOnly && fs.existsSync(path.join(args.demoDir, 'assets'))) {
    const html = fs.readFileSync(path.join(args.demoDir, 'demo.html'), 'utf8');
    if (/<source src="(?!data:)/.test(html)) {
      console.log(
        '  warning    this demo links a call video, so --customer-only omits the MP4.' +
          ' Send the full bundle instead.'
      );
    }
  }
}

main();
