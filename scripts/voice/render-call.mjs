#!/usr/bin/env node
'use strict';

/**
 * render-call.mjs — screenshot every frame of the render engine and encode the MP4.
 *
 * Stages the template plus the generated data.js / scenes.js / assets.js into the build folder,
 * drives window.render(t) frame by frame with Playwright, then muxes the frames against
 * call-mix.wav with the audio delayed by the intro length.
 *
 * Use --contact-sheet first: it renders a dozen sample times into review/ so layout problems
 * surface in seconds rather than after a full render.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadPlaywright } from '../lib/playwright.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'template');
const FPS = 30;

const USAGE = `
Usage: node render-call.mjs --recording <recording.json> [options]

  --recording <file>    The demo recording (required)
  --out-dir <dir>       Build folder (default: <recording dir>/voice-build)
  --video <file>        MP4 to write (default: <recording dir>/assets/call-demo.mp4)
  --contact-sheet       Render 12 sample frames into review/ and stop
  --frames-only         Render frames but skip the encode
  --crf <n>             x264 quality, lower is better (default: 21)
  --keep-frames         Leave the frames/ folder in place after encoding

Requires Playwright (Chromium) and ffmpeg on PATH.
`;

function parseArgs(argv) {
  const out = { crf: '21' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--video') out.video = argv[++i];
    else if (a === '--crf') out.crf = argv[++i];
    else if (a === '--contact-sheet') out.sheet = true;
    else if (a === '--frames-only') out.framesOnly = true;
    else if (a === '--keep-frames') out.keepFrames = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`render-call: ${msg}`);
  process.exit(code);
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: true });
  return r.status === 0;
}

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** Inline brand assets so the page has no network or relative-path dependencies. */
function dataUri(file) {
  if (!file || !fs.existsSync(file)) return null;
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.recording) {
    console.log(USAGE.trim());
    process.exit(args.recording ? 0 : 1);
  }

  const recPath = path.resolve(args.recording);
  if (!fs.existsSync(recPath)) fail(`no recording at ${recPath}`, 66);
  const demoDir = path.dirname(recPath);
  const outDir = args.outDir || path.join(demoDir, 'voice-build');

  for (const required of ['data.js', 'scenes.json', 'call-mix.wav']) {
    if (!fs.existsSync(path.join(outDir, required))) {
      fail(`${required} is missing from ${outDir} — run synth-call.mjs and plan-scenes.mjs first`, 66);
    }
  }

  const scenes = JSON.parse(fs.readFileSync(path.join(outDir, 'scenes.json'), 'utf8'));
  const land = scenes.format === '16x9';
  const [W, H] = land ? [1920, 1080] : [1080, 1920];

  // Stage the engine next to the generated data so the page loads everything over file://.
  for (const f of ['video.html', 'styles.css', 'app.js']) {
    fs.copyFileSync(path.join(TEMPLATE, f), path.join(outDir, f));
  }
  fs.writeFileSync(path.join(outDir, 'scenes.js'), `window.SCENES=${JSON.stringify(scenes)};\n`);
  fs.writeFileSync(
    path.join(outDir, 'assets.js'),
    `window.ASSETS=${JSON.stringify({
      customerLogo: dataUri(scenes.logo ? path.resolve(demoDir, scenes.logo) : null),
      partnerLogo: dataUri(path.join(demoDir, 'assets', 'partner-logo.png')),
      genesysLogo: dataUri(path.join(demoDir, 'assets', 'genesys-logo.svg')),
      agentGlyph: dataUri(path.join(demoDir, 'assets', 'genesys-glyph.png')),
    })};\n`
  );

  const { chromium } = await loadPlaywright({
    toolName: 'render-call',
    hint: 'The call video cannot be rendered without it.',
  });
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(outDir, 'video.html')).href);
  await page.waitForFunction('typeof window.render === "function"');
  await page.waitForTimeout(600); // let webfonts and inlined images settle before frame 0

  const total = await page.evaluate('window.TOTAL');
  const intro = await page.evaluate('window.INTRO');

  if (args.sheet) {
    const reviewDir = path.join(demoDir, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const m = await page.evaluate('window.MARKS');

    // One frame well inside each scene, plus four spread across the call where the cards,
    // chips and capability banners actually change.
    const shots = [
      ['intro', m.intro + 2.6],
      ['answering', m.answering + 1.0],
      ...[0.15, 0.4, 0.65, 0.9].map((f, i) => [`call-${i + 1}`, m.call + (m.callEnd - m.call) * f]),
      ['call-end', m.callEnd + 0.8],
      ['recap', m.recap + 4.5],
      ['outcome', m.outcome + 3.5],
      ['outro', m.outro + 3.0],
      ['cta', m.cta + 4.5],
    ];

    for (const [name, t] of shots) {
      await page.evaluate(`render(${t})`);
      await page.screenshot({
        path: path.join(reviewDir, `voice-${name}.jpg`),
        type: 'jpeg',
        quality: 88,
      });
    }
    await browser.close();
    console.log(`render-call: ${shots.length} sample frames in ${reviewDir}`);
    console.log(`  ${shots.map(([n]) => n).join(', ')}`);
    console.log('  Look at them before committing to the full render.');
    return;
  }

  const frameDir = path.join(outDir, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const frames = Math.ceil(total * FPS) + 1;
  console.log(`render-call: ${frames} frames · ${total.toFixed(1)}s · ${W}x${H}`);
  const started = Date.now();
  for (let f = 0; f < frames; f += 1) {
    await page.evaluate(`render(${f / FPS})`);
    await page.screenshot({
      path: path.join(frameDir, `${String(f).padStart(5, '0')}.jpg`),
      type: 'jpeg',
      quality: 90,
    });
    if (f % 60 === 0 || f === frames - 1) {
      const pct = ((f + 1) / frames) * 100;
      const rate = (f + 1) / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${pct.toFixed(0)}%  ${rate.toFixed(1)} fps   `);
    }
  }
  process.stdout.write('\n');
  await browser.close();

  if (args.framesOnly) {
    console.log(`  frames in ${frameDir} — encode them yourself or re-run without --frames-only.`);
    return;
  }
  if (!hasFfmpeg()) {
    fail(
      `ffmpeg is not on PATH, so the frames in ${frameDir} could not be encoded.\n` +
        '  Install ffmpeg and re-run, or encode the frames yourself.',
      69
    );
  }

  const video = args.video || path.join(demoDir, 'assets', 'call-demo.mp4');
  fs.mkdirSync(path.dirname(video), { recursive: true });
  console.log('  encoding…');
  execFileSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-framerate', String(FPS), '-i', path.join(frameDir, '%05d.jpg'),
     '-i', path.join(outDir, 'call-mix.wav'),
     // The audio starts when the call scene does, not at frame 0.
     '-filter_complex', `[1:a]adelay=${Math.round(intro * 1000)}|${Math.round(intro * 1000)},apad[a]`,
     '-map', '0:v', '-map', '[a]',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(args.crf), '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', video],
    { stdio: 'inherit' }
  );

  const poster = video.replace(/\.mp4$/i, '-poster.png');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', '3', '-i', video, '-frames:v', '1', poster], { stdio: 'inherit' });

  if (!args.keepFrames) fs.rmSync(frameDir, { recursive: true, force: true });

  const mb = (fs.statSync(video).size / 1048576).toFixed(1);
  console.log(`  video   ${video} (${mb} MB, ${total.toFixed(1)}s)`);
  console.log(`  poster  ${poster}`);
}

main().catch((err) => fail(err.message));
