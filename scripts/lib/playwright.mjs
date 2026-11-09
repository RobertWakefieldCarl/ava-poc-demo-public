'use strict';

/**
 * Resolving Playwright is fiddly because this skill runs on facilitator laptops that may have it
 * installed locally, globally, or only nested inside a global @playwright/cli. Every script that
 * drives a browser goes through here so they all find the same install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright({ toolName = 'ava-poc-demo', hint = '' } = {}) {
  try {
    return await import('playwright');
  } catch {
    /* not resolvable from the current working directory */
  }

  let globalRoot = null;
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
  } catch {
    /* npm not on PATH */
  }

  if (globalRoot) {
    const candidates = [
      path.join(globalRoot, 'playwright', 'index.js'),
      path.join(globalRoot, '@playwright', 'cli', 'node_modules', 'playwright', 'index.js'),
      path.join(globalRoot, '@playwright', 'test', 'node_modules', 'playwright', 'index.js'),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const mod = await import(pathToFileURL(candidate).href);
        // CommonJS builds surface their exports under .default when imported by path.
        return mod.chromium ? mod : mod.default;
      } catch {
        /* try the next candidate */
      }
    }
  }

  console.error(
    `${toolName}: playwright is not installed.\n` +
      '  npm i -D playwright && npx playwright install chromium' +
      (hint ? `\n  ${hint}` : '')
  );
  process.exit(2);
}
