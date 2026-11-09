#!/usr/bin/env node
'use strict';

/**
 * Verify a generated demo.html actually plays, and capture review screenshots.
 *
 * Usage:
 *   node verify-demo.mjs --demo <dir>/demo.html [--speed 4] [--timeout 180000] [--headed]
 *
 * Writes review/demo-initial.png (at rest) and review/demo-played.png (after playback)
 * beside the demo, and exits non-zero if anything is wrong. Checks:
 *
 *   - the backdrop screenshot and the logo actually decoded (a broken data URI is
 *     invisible in the HTML source but obvious to the customer)
 *   - every message in recording.json reached the page
 *   - no unreplaced {{tokens}} survived templating
 *   - no console or page errors during playback
 *
 * This replaces eyeballing the file, which cannot catch an asset that silently failed
 * to inline or a playback loop that stalls halfway.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';

function parseArgs(argv) {
  const out = { demo: null, speed: '4', timeout: 180000, headed: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') out.demo = path.resolve(argv[++i]);
    else if (a === '--speed') out.speed = String(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--headed') out.headed = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `Usage:
  node verify-demo.mjs --demo <dir>/demo.html

Options:
  --speed <1|1.5|2|4>   Playback speed to verify at (default 4)
  --timeout <ms>        Max time to wait for playback (default 180000)
  --headed              Watch it run in a visible browser
`;


async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.demo) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.demo)) {
    console.error(`verify-demo: no such file: ${args.demo}`);
    process.exit(66);
  }

  const dir = path.dirname(args.demo);
  const reviewDir = path.join(dir, 'review');
  fs.mkdirSync(reviewDir, { recursive: true });

  // Expected counts come from the recording, so this works for any demo length.
  let expectedBubbles = 0;
  let expectedUseCases = 0;
  let expectedCaps = 0;
  let expectedLines = 0;
  const recPath = path.join(dir, 'recording.json');
  if (fs.existsSync(recPath)) {
    try {
      const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
      expectedBubbles = (rec.messages || []).length;
      expectedUseCases = (rec.useCases || []).length;
      expectedCaps = ((rec.voice || {}).capabilities || []).length;
      expectedLines = ((rec.voice || {}).transcript || []).length;
    } catch {
      console.warn('verify-demo: recording.json is unreadable; skipping the count checks');
    }
  }

  const { chromium } = await loadPlaywright({
    toolName: 'verify-demo',
    hint: 'Or skip verification and check demo.html by hand (see SKILL.md Step 6).',
  });
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const problems = [];
  try {
    await page.goto(pathToFileURL(args.demo).href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const atRest = await page.evaluate(() => {
      const decoded = (sel) => {
        const img = document.querySelector(sel);
        return { present: !!img, ok: !!img && img.complete && img.naturalWidth > 0 };
      };
      return {
        hasDigital: !!document.getElementById('digitalPanel') || !!document.getElementById('msgs'),
        hasVoice: !!document.getElementById('voicePanel'),
        pageShot: decoded('.page-shot'),
        logo: decoded('.logo'),
        bubbles: document.querySelectorAll('.bubble').length,
        useCases: document.querySelectorAll('#chapters .chapter').length,
        caps: document.querySelectorAll('#caps .cap').length,
        lines: document.querySelectorAll('#tlines .tline').length,
        unreplaced: (document.body.innerHTML.match(/\{\{[a-zA-Z0-9_.]+\}\}/g) || []).length,
      };
    });
    await page.screenshot({ path: path.join(reviewDir, 'demo-initial.png') });

    if (atRest.unreplaced) problems.push(`${atRest.unreplaced} unreplaced {{token}}(s) in the page`);
    if (atRest.logo.present && !atRest.logo.ok) {
      problems.push('the logo did not decode — check customer.logoFile');
    }

    // The backdrop only exists on the digital channel; a voice-only demo has no page shot.
    if (atRest.hasDigital) {
      if (atRest.pageShot.present && !atRest.pageShot.ok) {
        problems.push('the customer page backdrop did not decode — check customer.pageImage');
      }
      if (!atRest.pageShot.present) problems.push('no page backdrop in the demo at all');
      if (expectedUseCases && atRest.useCases !== expectedUseCases) {
        problems.push(`use-case rail shows ${atRest.useCases} of ${expectedUseCases} chapters`);
      }
    }
    if (atRest.hasVoice) {
      if (expectedCaps && atRest.caps !== expectedCaps) {
        problems.push(`capability rail shows ${atRest.caps} of ${expectedCaps} entries`);
      }
      if (expectedLines && atRest.lines !== expectedLines) {
        problems.push(`call transcript shows ${atRest.lines} of ${expectedLines} lines`);
      }
    }

    const played = { bubbles: 0, chips: 0, last: '' };

    if (atRest.hasDigital) {
      // Play at speed and wait for every recorded turn to land.
      for (const label of [`${args.speed}×`, `${args.speed}x`]) {
        const b = page.locator(`#digitalPanel button:has-text("${label}"), button:has-text("${label}")`).first();
        if (await b.count()) {
          await b.click();
          break;
        }
      }
      await page.locator('#playBtn').first().click();

      if (expectedBubbles) {
        await page
          .waitForFunction((n) => document.querySelectorAll('.bubble').length >= n, expectedBubbles, {
            timeout: args.timeout,
          })
          .catch(() =>
            problems.push(`playback stalled before all ${expectedBubbles} turns rendered`)
          );
      } else {
        await page.waitForTimeout(Math.min(args.timeout, 30000));
      }
      await page.waitForTimeout(1200);

      Object.assign(
        played,
        await page.evaluate(() => {
          const b = document.querySelectorAll('.bubble');
          return {
            bubbles: b.length,
            chips: document.querySelectorAll('.act').length,
            last: (b[b.length - 1]?.textContent || '').trim().slice(0, 70),
          };
        })
      );
      await page.screenshot({ path: path.join(reviewDir, 'demo-played.png') });

      if (expectedBubbles && played.bubbles < expectedBubbles) {
        problems.push(`only ${played.bubbles} of ${expectedBubbles} turns rendered`);
      }
    }

    let video = null;
    if (atRest.hasVoice) {
      // On a combined demo the voice panel starts hidden, so switch to it first.
      const tab = page.locator('.tab:has-text("Call video")').first();
      if (await tab.count()) {
        await tab.click();
        await page.waitForTimeout(400);
      }

      video = await page.evaluate(async () => {
        const v = document.querySelector('#vid');
        if (!v) return { present: false };
        const src = v.querySelector('source')?.getAttribute('src') || v.src || '';
        if (v.readyState < 1) {
          await new Promise((resolve) => {
            const done = () => resolve();
            v.addEventListener('loadedmetadata', done, { once: true });
            v.addEventListener('error', done, { once: true });
            setTimeout(done, 8000);
          });
        }
        return {
          present: true,
          src,
          readyState: v.readyState,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          width: v.videoWidth,
          errorCode: v.error ? v.error.code : null,
        };
      });

      // A linked MP4 that 404s is invisible in the HTML but fatal in front of a customer.
      if (!video.present) problems.push('the voice panel has no <video> element');
      else if (video.errorCode === 4 || video.readyState === 0) {
        problems.push(
          `the call video did not load (${video.src}) — check the path is correct and the file ` +
            'travels with demo.html'
        );
      } else if (!video.duration) {
        console.log(
          '  note         video metadata unavailable in this browser build (likely no H.264 ' +
            'codec in headless Chromium) — confirm playback by hand'
        );
      }

      await page.screenshot({ path: path.join(reviewDir, 'demo-voice.png') });
    }

    if (errors.length) problems.push(...errors);

    const kb = Math.round(fs.statSync(args.demo).size / 1024);
    console.log(`verify-demo: ${path.basename(args.demo)} (${kb} KB)`);
    console.log(
      `  channels     ${[atRest.hasDigital && 'digital', atRest.hasVoice && 'voice'].filter(Boolean).join(' + ')}`
    );
    if (atRest.hasDigital) {
      console.log(`  turns        ${played.bubbles}${expectedBubbles ? ` of ${expectedBubbles}` : ''}`);
      console.log(`  tool chips   ${played.chips}`);
      console.log(`  use cases    ${atRest.useCases}${expectedUseCases ? ` of ${expectedUseCases}` : ''}`);
      console.log(`  last turn    ${played.last || '(none)'}`);
    }
    if (atRest.hasVoice) {
      console.log(`  capabilities ${atRest.caps}${expectedCaps ? ` of ${expectedCaps}` : ''}`);
      console.log(`  call lines   ${atRest.lines}${expectedLines ? ` of ${expectedLines}` : ''}`);
      console.log(
        `  video        ${video && video.duration ? `${video.duration.toFixed(1)}s @ ${video.width}px` : 'metadata unavailable'}`
      );
    }
    console.log(`  review       ${path.join(reviewDir, 'demo-initial.png')}`);
    if (atRest.hasDigital) console.log(`               ${path.join(reviewDir, 'demo-played.png')}`);
    if (atRest.hasVoice) console.log(`               ${path.join(reviewDir, 'demo-voice.png')}`);
    if (kb > 4000) {
      console.log(
        '  note         over 4 MB — many mail servers will reject it. Re-capture the' +
          ' backdrop with --quality 70 or --max-height 3000, or generate with --no-embed.'
      );
    }
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\nverify-demo: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\nverify-demo: OK — the demo plays start to finish with no errors.');
}

main().catch((err) => {
  console.error(`verify-demo: ${err.message}`);
  process.exit(1);
});
