#!/usr/bin/env node
'use strict';

/**
 * build-voice-video.mjs — recording.json in, call-demo.mp4 out.
 *
 * Runs the three transcript-driven stages in order and then writes the finished video back into
 * recording.json's voice block, so `generate-demo.mjs --both` picks it up with no hand editing.
 * Each stage is also runnable on its own (see scripts/voice/) when you want to tune one of them.
 *
 *   1. synth-call.mjs   speak the transcript  → call-mix.wav + data.js
 *   2. plan-scenes.mjs  derive the visuals    → scenes.json
 *   3. render-call.mjs  frames + encode       → assets/call-demo.mp4
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTRO = 6.0; // must match app.js; chapter times are seconds into the finished MP4

const USAGE = `
Usage: node build-voice-video.mjs --recording <recording.json> [options]

  --recording <file>    The demo recording (required)
  --format <9x16|16x9>  Aspect ratio (default: from recording.voice.format, else 9x16)
  --agent-voice <v>     ElevenLabs voice name or id for the AVA
  --caller-voice <v>    ElevenLabs voice name or id for the caller
  --replan              Rebuild scenes.json, discarding hand edits
  --contact-sheet       Stop after sample frames so you can check the layout
  --dry-run             Report the synthesis cost and stop

Requires ELEVENLABS_API_KEY, Playwright (Chromium) and ffmpeg.
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--agent-voice') out.agentVoice = argv[++i];
    else if (a === '--caller-voice') out.callerVoice = argv[++i];
    else if (a === '--replan') out.replan = true;
    else if (a === '--contact-sheet') out.sheet = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function run(script, argv) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...argv], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`build-voice-video: ${path.basename(script)} failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
}

function readData(file) {
  const m = fs.readFileSync(file, 'utf8').match(/window\.DATA\s*=\s*([\s\S]+?);\s*$/);
  return JSON.parse(m[1]);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.recording) {
    console.log(USAGE.trim());
    process.exit(args.recording ? 0 : 1);
  }

  const recPath = path.resolve(args.recording);
  if (!fs.existsSync(recPath)) {
    console.error(`build-voice-video: no recording at ${recPath}`);
    process.exit(66);
  }
  const demoDir = path.dirname(recPath);
  const outDir = path.join(demoDir, 'voice-build');

  const synthArgs = ['--recording', recPath];
  if (args.agentVoice) synthArgs.push('--agent-voice', args.agentVoice);
  if (args.callerVoice) synthArgs.push('--caller-voice', args.callerVoice);
  if (args.dryRun) synthArgs.push('--dry-run');
  run('voice/synth-call.mjs', synthArgs);
  if (args.dryRun) return;

  const planArgs = ['--recording', recPath];
  if (args.format) planArgs.push('--format', args.format);
  if (args.replan) planArgs.push('--force');
  run('voice/plan-scenes.mjs', planArgs);

  run('voice/render-call.mjs', [
    '--recording', recPath,
    ...(args.sheet ? ['--contact-sheet'] : []),
  ]);
  if (args.sheet) return;

  // --- wire the finished video back into the recording --------------------------

  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const data = readData(path.join(outDir, 'data.js'));
  const scenes = JSON.parse(fs.readFileSync(path.join(outDir, 'scenes.json'), 'utf8'));
  const video = path.join(demoDir, 'assets', 'call-demo.mp4');
  const poster = path.join(demoDir, 'assets', 'call-demo-poster.png');

  const firstUseCase = (rec.useCases || [])[0];
  rec.voice = {
    ...(rec.voice || {}),
    source: 'transcript',
    videoFile: 'assets/call-demo.mp4',
    ...(fs.existsSync(poster) ? { poster: 'assets/call-demo-poster.png' } : {}),
    format: scenes.format,
    title: (rec.voice && rec.voice.title) || `Inbound call — ${firstUseCase ? firstUseCase.title : 'AVA demo'}`,
    agentName: scenes.agentName,
    callerName: scenes.callerName,
    // Chapter marks are seconds into the finished MP4, so the intro has to be added back on.
    capabilities: scenes.caps.map((c) => ({
      at: +(INTRO + c.at).toFixed(1),
      title: c.title,
      subtitle: c.subtitle,
    })),
    outcomes: scenes.outcome.tiles.map((t) => ({ label: t.label, value: t.value })),
    transcript: data.segs.map((s) => ({
      at: +(INTRO + s.start).toFixed(1),
      speaker: s.ch === 'R' ? 'agent' : 'caller',
      text: s.text,
    })),
  };

  fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`);

  const mb = fs.existsSync(video) ? (fs.statSync(video).size / 1048576).toFixed(1) : '?';
  console.log(`\nbuild-voice-video: done — ${mb} MB, ${scenes.format}`);
  console.log(`  recording.json voice block updated (${rec.voice.capabilities.length} chapters,` +
    ` ${rec.voice.transcript.length} transcript lines)`);
  console.log('  Next: node scripts/generate-demo.mjs --recording "' + recPath + '"');
}

main();
