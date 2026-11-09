#!/usr/bin/env node
'use strict';

/**
 * synth-call.mjs — turn the Cicero transcript in recording.json into call audio.
 *
 * The recorded-call pipeline derives timing from ASR and VAD. Here we are generating the speech
 * ourselves, so we know every line's exact duration and the timeline is simply the lines laid end
 * to end with deliberate gaps. That means no diarization, no silence tightening, and an identity
 * time map — fwd() in the render engine stays a no-op and the rest of the engine is unchanged.
 *
 * Audio is requested as raw PCM so the whole pipeline runs in Node with no ffmpeg dependency.
 * Some ElevenLabs plans refuse PCM output, in which case we fall back to MP3 and decode with
 * ffmpeg (which the render step needs anyway).
 *
 * Outputs into <voice-build>/:
 *   call-mix.wav   24 kHz mono, the audio bed for the video
 *   data.js        window.DATA = { segs, map, env, callDur } for the render engine
 *   lines/*.pcm    per-line cache keyed by text+voice+model, so re-runs cost nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveSecret } from '../lib/secrets.mjs';

const SAMPLE_RATE = 24000;
const FPS = 30;
const API = 'https://api.elevenlabs.io/v1';

/** Gaps between turns, in seconds. Speaker changes need more air than a continuation. */
const GAP_TURNAROUND = 0.45;
const GAP_SAME_SPEAKER = 0.3;
/** Extra pause before an agent turn that ran tools, so its action card has room to land. */
const GAP_THINKING = 1.1;

const USAGE = `
Usage: node synth-call.mjs --recording <recording.json> [options]

  --recording <file>   The demo recording to speak (required)
  --out-dir <dir>      Build folder (default: <recording dir>/voice-build)
  --agent-voice <v>    ElevenLabs voice name or id for the AVA
  --caller-voice <v>   ElevenLabs voice name or id for the caller
  --model <id>         ElevenLabs model (default: eleven_v4_turbo)
  --no-cache           Re-synthesize every line even if it is cached
  --dry-run            Report what would be synthesized and the cost, then stop

Requires ELEVENLABS_API_KEY in the environment.
`;

function parseArgs(argv) {
  const out = { model: null, cache: true, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--agent-voice') out.agentVoice = argv[++i];
    else if (a === '--caller-voice') out.callerVoice = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--no-cache') out.cache = false;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`synth-call: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- ElevenLabs

async function el(apiKey, route, init = {}) {
  const res = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'xi-api-key': apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * Accounts label voices as "Adam - Dominant, Firm" rather than plain "Adam", so match on the
 * leading name segment before falling back to a substring search. Facilitators type the short
 * name they see at the top of the ElevenLabs UI.
 */
const shortName = (name) => String(name).split(/\s+[-–—]\s+/)[0].trim();

function findVoice(list, wanted) {
  const w = String(wanted).toLowerCase().trim();
  return (
    list.find((v) => v.name.toLowerCase() === w) ||
    list.find((v) => shortName(v.name).toLowerCase() === w) ||
    list.find((v) => v.name.toLowerCase().includes(w))
  );
}

/**
 * Pick a stand-in when the requested voice is not on this account. Two different-sounding
 * voices matter more than which two, so prefer a conversational voice of the expected gender
 * and fall back to any voice that is not already taken.
 */
function autoVoice(list, gender, taken) {
  const free = list.filter((v) => v.voice_id !== taken);
  return (
    free.find((v) => v.labels?.gender === gender && v.labels?.use_case === 'conversational') ||
    free.find((v) => v.labels?.gender === gender) ||
    free[0]
  );
}

/**
 * Accept either a voice id or a human-readable name, because facilitators pick voices in the
 * ElevenLabs UI where only names are visible.
 */
async function resolveVoice(getKey, wanted, role, cache, { explicit, gender, taken }) {
  if (/^[A-Za-z0-9]{20,}$/.test(wanted)) return { id: wanted, name: wanted };
  if (cache.known[wanted]) return { id: cache.known[wanted], name: wanted };

  if (!cache.list) {
    const res = await el(getKey(), '/voices');
    cache.list = (await res.json()).voices || [];
  }

  let hit = findVoice(cache.list, wanted);

  if (!hit && explicit) {
    const names = cache.list.map((v) => shortName(v.name)).join(', ');
    fail(`no ElevenLabs voice matching "${wanted}" for the ${role}.\n  Available: ${names || '(none)'}`);
  }
  if (!hit) {
    // The built-in default is not on this account. Substituting beats failing, but say so
    // loudly — the voice is part of the deliverable.
    hit = autoVoice(cache.list, gender, taken);
    if (!hit) fail(`this ElevenLabs account exposes no voices to use for the ${role}.`);
    console.log(
      `  note: no voice named "${wanted}" on this account — using "${shortName(hit.name)}" for` +
        ` the ${role}. Set voice.tts.${role}Voice in recording.json to choose deliberately.`
    );
  }

  cache.known[wanted] = hit.voice_id;
  return { id: hit.voice_id, name: shortName(hit.name) };
}

/** Returns mono 16-bit PCM at SAMPLE_RATE. */
async function speak(getKey, { text, voiceId, model, settings }) {
  const apiKey = getKey();
  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.75,
      style: 0.2,
      use_speaker_boost: true,
      ...settings,
    },
  });
  const headers = { 'Content-Type': 'application/json' };

  try {
    const res = await el(apiKey, `/text-to-speech/${voiceId}?output_format=pcm_${SAMPLE_RATE}`, {
      method: 'POST',
      headers: { ...headers, Accept: 'audio/pcm' },
      body,
    });
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // PCM output is gated on some plans; MP3 is always available and ffmpeg is already a
    // prerequisite for encoding the video.
    if (err.status !== 401 && err.status !== 403 && err.status !== 422) throw err;
    const res = await el(apiKey, `/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { ...headers, Accept: 'audio/mpeg' },
      body,
    });
    return mp3ToPcm(Buffer.from(await res.arrayBuffer()));
  }
}

function mp3ToPcm(mp3) {
  try {
    return execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
       '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
      { input: mp3, maxBuffer: 1 << 28 }
    );
  } catch (err) {
    fail(
      'this ElevenLabs plan returned MP3 instead of PCM, and ffmpeg is not available to decode it.\n' +
        `  Install ffmpeg, or upgrade the plan to allow PCM output. (${err.message.split('\n')[0]})`
    );
  }
}

// ----------------------------------------------------------------- PCM utils

const silence = (seconds) => Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2);

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Peak-normalize to 0.9 so every demo lands at a predictable loudness. */
function normalize(pcm) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  if (!peak) return pcm;
  const gain = Math.min(4, (0.9 * 32767) / peak);
  if (gain <= 1.01) return pcm;
  for (let i = 0; i < pcm.length; i += 2) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  }
  return pcm;
}

/**
 * Per-channel RMS at FPS, normalized to the 99th percentile. The waveform bars read this, so a
 * flat-but-nonzero floor during the other speaker's turn would look like both avatars talking.
 */
function envelopes(pcm, segs) {
  const frames = Math.ceil(pcm.length / 2 / (SAMPLE_RATE / FPS));
  const per = SAMPLE_RATE / FPS;
  const raw = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    let n = 0;
    for (let s = Math.floor(f * per); s < Math.floor((f + 1) * per) && s * 2 + 1 < pcm.length; s += 1) {
      const v = pcm.readInt16LE(s * 2) / 32768;
      sum += v * v;
      n += 1;
    }
    raw[f] = n ? Math.sqrt(sum / n) : 0;
  }

  const sorted = [...raw].filter((v) => v > 0).sort((a, b) => a - b);
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 1;
  const norm = Array.from(raw, (v) => Math.min(1, v / (p99 || 1)));

  // Route each frame to the channel that owns it; silence belongs to neither.
  const L = new Array(frames).fill(0);
  const R = new Array(frames).fill(0);
  for (const seg of segs) {
    const target = seg.ch === 'R' ? R : L;
    for (let f = Math.floor(seg.start * FPS); f < Math.min(frames, Math.ceil(seg.end * FPS)); f += 1) {
      target[f] = norm[f];
    }
  }
  return { L, R };
}

// ------------------------------------------------------------------- the job

/** Flatten the recording into the lines to speak, in order. */
function linesFrom(rec) {
  return (rec.messages || [])
    .map((m) => ({
      ch: m.role === 'agent' ? 'R' : 'L',
      text: String(m.text || '').trim(),
      hasActions: Array.isArray(m.actions) && m.actions.length > 0,
      useCaseId: m.useCaseId || null,
    }))
    .filter((l) => l.text);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.recording) {
    console.log(USAGE.trim());
    process.exit(args.recording ? 0 : 1);
  }
  if (!fs.existsSync(args.recording)) fail(`no recording at ${args.recording}`, 66);

  const rec = JSON.parse(fs.readFileSync(args.recording, 'utf8'));
  const tts = (rec.voice && rec.voice.tts) || {};
  const outDir = args.outDir || path.join(path.dirname(path.resolve(args.recording)), 'voice-build');
  const lineDir = path.join(outDir, 'lines');
  fs.mkdirSync(lineDir, { recursive: true });

  const model = args.model || tts.model || 'eleven_v4_turbo';
  const wantAgent = args.agentVoice || tts.agentVoice || 'Rachel';
  const wantCaller = args.callerVoice || tts.callerVoice || 'Adam';

  const lines = linesFrom(rec);
  if (!lines.length) fail('the recording has no messages to speak', 66);

  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  if (args.dryRun) {
    console.log(`synth-call: ${lines.length} lines, ${chars} characters`);
    console.log(`  voices  agent "${wantAgent}" · caller "${wantCaller}" · model ${model}`);
    console.log('  Cached lines are free; only changed text is re-synthesized.');
    return;
  }

  // The key is only demanded at the moment we actually need to call the API. A re-run where
  // every line is cached and the voice ids are already known costs nothing and needs no key.
  let keySource = null;
  const getKey = () => {
    const { value, source } = resolveSecret('elevenlabs', 'ELEVENLABS_API_KEY');
    if (!value) {
      fail(
        'no ElevenLabs API key available, and this run needs to synthesize new speech.\n' +
          '  Store it once, in the OS keystore:\n' +
          '    node "<SkillDir>/scripts/credentials.mjs" set elevenlabs\n' +
          '  Or set ELEVENLABS_API_KEY in the environment for a one-off.',
        78
      );
    }
    if (!keySource) {
      keySource = source;
      console.log(`  key from      ${source}`);
    }
    return value;
  };

  const voicesFile = path.join(outDir, 'voices.json');
  const cache = {
    known: fs.existsSync(voicesFile) ? JSON.parse(fs.readFileSync(voicesFile, 'utf8')) : {},
  };
  const agentExplicit = !!(args.agentVoice || tts.agentVoice);
  const callerExplicit = !!(args.callerVoice || tts.callerVoice);
  const agent = await resolveVoice(getKey, wantAgent, 'agent', cache, {
    explicit: agentExplicit,
    gender: 'female',
  });
  const caller = await resolveVoice(getKey, wantCaller, 'caller', cache, {
    explicit: callerExplicit,
    gender: 'male',
    taken: agent.id,
  });
  fs.writeFileSync(voicesFile, `${JSON.stringify(cache.known, null, 2)}\n`);
  console.log(`synth-call: agent "${agent.name}" · caller "${caller.name}" · ${model}`);

  const parts = [];
  const segs = [];
  let cursor = 0;
  let spoken = 0;
  let reused = 0;

  for (const [i, line] of lines.entries()) {
    const voice = line.ch === 'R' ? agent : caller;
    const settings = line.ch === 'R' ? tts.agentSettings : tts.callerSettings;
    const key = crypto
      .createHash('sha1')
      .update(JSON.stringify([line.text, voice.id, model, settings || null]))
      .digest('hex')
      .slice(0, 16);
    const cached = path.join(lineDir, `${key}.pcm`);

    let pcm;
    if (args.cache && fs.existsSync(cached)) {
      pcm = fs.readFileSync(cached);
      reused += 1;
    } else {
      pcm = await speak(getKey, { text: line.text, voiceId: voice.id, model, settings });
      fs.writeFileSync(cached, pcm);
      spoken += 1;
    }

    const prev = lines[i - 1];
    if (prev) {
      let gap = prev.ch === line.ch ? GAP_SAME_SPEAKER : GAP_TURNAROUND;
      if (line.ch === 'R' && line.hasActions) gap += GAP_THINKING;
      parts.push(silence(gap));
      cursor += gap;
    }

    const dur = pcm.length / 2 / SAMPLE_RATE;
    segs.push({
      ch: line.ch,
      start: +cursor.toFixed(3),
      end: +(cursor + dur).toFixed(3),
      text: line.text,
      useCaseId: line.useCaseId,
    });
    parts.push(pcm);
    cursor += dur;

    process.stdout.write(`\r  line ${i + 1}/${lines.length}  ${cursor.toFixed(1)}s`);
  }
  process.stdout.write('\n');

  const pcm = normalize(Buffer.concat(parts));
  const callDur = +(pcm.length / 2 / SAMPLE_RATE).toFixed(3);

  fs.writeFileSync(path.join(outDir, 'call-mix.wav'), wavFromPcm(pcm));
  fs.writeFileSync(
    path.join(outDir, 'data.js'),
    // The time map is identity: synthesized audio has no silence to tighten, so fwd() is a no-op
    // and scene times can be written directly in call seconds.
    `window.DATA=${JSON.stringify(
      { segs, map: [[0, 0, callDur]], env: envelopes(pcm, segs), callDur },
      null,
      0
    )};\n`
  );

  console.log(`  call-mix.wav  ${callDur.toFixed(1)}s · ${segs.length} segments`);
  console.log(`  synthesized   ${spoken} lines${reused ? `, reused ${reused} from cache` : ''}`);
  console.log(`  data.js       ${path.join(outDir, 'data.js')}`);
}

main().catch((err) => fail(err.message));
