'use strict';

/**
 * Shared packaging for the poc-demo folder.
 *
 * Uses the platform's own zip tooling — PowerShell's Compress-Archive on Windows, the
 * `zip` command elsewhere — so there is no dependency to install.
 *
 * generate-demo.mjs calls this straight after writing the demo so a complete bundle
 * always exists; package-demo.mjs calls it again after verification to fold in review/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Everything a facilitator needs to reopen, re-render or hand off the demo. */
export const FULL_ITEMS = ['demo.html', 'transcript.md', 'recording.json', 'assets', 'review'];

/** Just what a customer should receive. Only valid when no MP4 is linked. */
export const CUSTOMER_ITEMS = ['demo.html', 'transcript.md'];

function zipWindows(items, outFile, cwd) {
  // -LiteralPath takes the member list directly, so no shell globbing is involved.
  const list = items.map((i) => `'${path.join(cwd, i).replace(/'/g, "''")}'`).join(',');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath ${list} -DestinationPath '${outFile.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'pipe' }
  );
}

function zipPosix(items, outFile, cwd) {
  execFileSync('zip', ['-r', '-q', outFile, ...items], { cwd, stdio: 'pipe' });
}

/**
 * Zip the demo folder in place.
 *
 * @param {object} opts
 * @param {string} opts.demoDir   Folder holding demo.html
 * @param {string} [opts.outFile] Defaults to <demoDir>/demo.zip
 * @param {string[]} [opts.items] Member list, defaults to FULL_ITEMS
 * @returns {{outFile: string, items: string[], missing: string[], sizeKb: number}}
 * @throws if the zip tooling fails
 */
export function zipDemo({ demoDir, outFile, items = FULL_ITEMS }) {
  const target = outFile || path.join(demoDir, 'demo.zip');
  const present = items.filter((i) => fs.existsSync(path.join(demoDir, i)));
  const missing = items.filter((i) => !present.includes(i));

  if (!present.length) throw new Error('nothing to package');

  // Never ship a stale bundle from a previous run alongside a fresh one.
  if (fs.existsSync(target)) fs.rmSync(target);

  if (process.platform === 'win32') zipWindows(present, target, demoDir);
  else zipPosix(present, target, demoDir);

  return {
    outFile: target,
    items: present,
    missing,
    sizeKb: Math.round(fs.statSync(target).size / 1024),
  };
}
