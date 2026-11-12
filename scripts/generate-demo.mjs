#!/usr/bin/env node
'use strict';

/**
 * Build demo.html (branded AVA demo) and transcript.md from recording.json.
 *
 * Usage:
 *   node generate-demo.mjs --recording <dir>/recording.json [--out-dir <dir>]
 *     [--digital | --voice | --both]   channel to render (default --both)
 *     [--video <path>]                 override recording.voice.videoFile
 *     [--no-embed]                     link images instead of inlining them
 *     [--embed-video]                  inline the MP4 too (only for small files)
 *
 * --digital renders the animated web-chat replay over the customer's web page.
 * --voice   renders the call video player with capability chapters and call transcript.
 * --both    renders both behind a channel switcher (default).
 *
 * Images referenced by the recording are resolved relative to the recording file and
 * inlined as data URIs. The MP4 is linked by default, so a voice demo must travel
 * with its assets/ folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { zipDemo } from './lib/zip-demo.mjs';
import { stripVoiceTags } from './lib/voice-tags.mjs';

function parseArgs(argv) {
  const out = {
    recording: null,
    outDir: null,
    mode: null,
    video: null,
    embed: true,
    embedVideo: false,
    zip: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--recording') out.recording = path.resolve(argv[++i]);
    else if (a === '--out-dir') out.outDir = path.resolve(argv[++i]);
    else if (a === '--digital') out.mode = 'digital';
    else if (a === '--voice') out.mode = 'voice';
    else if (a === '--both') out.mode = 'both';
    else if (a === '--video') out.video = argv[++i];
    else if (a === '--no-embed') out.embed = false;
    else if (a === '--embed-video') out.embedVideo = true;
    else if (a === '--no-zip') out.zip = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `Usage:
  node generate-demo.mjs --recording <dir>/recording.json [options]

Channel:
  --digital        Animated web-chat replay on the customer's web page
  --voice          Call video player with capability chapters and transcript
  --both           Both, behind a channel switcher (default)

Options:
  --out-dir <dir>  Output folder (defaults to the recording's folder)
  --video <path>   Override recording.voice.videoFile
  --no-embed       Link images instead of inlining them
  --embed-video    Inline the MP4 as a data URI (only sensible for small files)
  --no-zip         Skip the demo.zip bundle written alongside the demo
`;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * The demo always renders the conversation as a chat widget, because a transcript is the
 * only honest way to show a phone call on a page. The wording still has to match the real
 * channel, so a voice AVA is never described as web chat.
 */
const CHANNELS = {
  voice: {
    headerLine:
      'Recorded phone call with the Genesys Cloud agentic virtual agent, shown here as a transcript.',
    transcriptChannel: (url) =>
      `voice — a recorded phone call, shown as a transcript${url ? ` on ${url}` : ''}`,
    subtitle: 'Recorded phone call · shown here as a transcript',
    inputPlaceholder: 'Caller speaking…',
    tabLabel: '📄 Call transcript',
    pill: 'Call transcript',
  },
  chat: {
    headerLine: 'Recorded web-chat conversation with the Genesys Cloud agentic virtual agent.',
    transcriptChannel: (url) => `web chat${url ? ` on ${url}` : ''}`,
    subtitle: 'AI assistant · replies instantly',
    inputPlaceholder: 'Type your message…',
    tabLabel: '💬 Web chat',
    pill: 'Web chat',
  },
  messaging: {
    headerLine: 'Recorded messaging conversation with the Genesys Cloud agentic virtual agent.',
    transcriptChannel: (url) => `messaging${url ? ` on ${url}` : ''}`,
    subtitle: 'AI assistant · replies in the messaging app',
    inputPlaceholder: 'Type your message…',
    tabLabel: '💬 Messaging',
    pill: 'Messaging',
  },
};

const DEFAULT_DISCLAIMER =
  'Recorded against the published AVA using mock Data Actions. Account numbers, balances ' +
  'and order details are demonstration data, not live customer records.';

/** Wrap prose to a readable width for the Markdown blockquote. */
function wrap(text, width = 92) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Embed a payload in a <script> tag without letting its contents close the tag. */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028|\u2029/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function assetUri(baseDir, relPath, embed) {
  if (!relPath) return null;
  if (/^(https?:|data:)/i.test(relPath)) return relPath;
  const abs = path.isAbsolute(relPath) ? relPath : path.resolve(baseDir, relPath);
  if (!fs.existsSync(abs)) {
    console.warn(`  warning: asset not found — ${relPath}`);
    return null;
  }
  if (!embed) return relPath.split(path.sep).join('/');
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

function normalize(rec, baseDir, args) {
  const customer = rec.customer || {};
  const ava = rec.ava || {};
  const widget = rec.widget || {};
  const brand = customer.brandColor || '#1a56a8';
  const channelKey = CHANNELS[ava.channel] ? ava.channel : 'chat';
  const copy = CHANNELS[channelKey];

  const messages = (rec.messages || []).map((m) => ({
    useCaseId: m.useCaseId || null,
    role: m.role === 'customer' || m.role === 'system' ? m.role : 'agent',
    // Expressive-TTS direction is for the voice engine, never for a reader.
    text: stripVoiceTags(m.text ?? m.speechText ?? ''),
    note: m.note || null,
    actions: (m.actions || []).map((a) => ({
      type: a.type || 'tool',
      name: a.name || 'action',
      label: a.label || null,
      input: a.input ?? null,
      output: a.output ?? null,
      status: a.status || 'ok',
    })),
  }));

  const v = rec.voice || {};
  const videoRel = args.video || v.videoFile || null;
  const videoSrc = assetUri(baseDir, videoRel, args.embedVideo);
  const voice = videoSrc
    ? {
        video: videoSrc,
        videoName: videoRel ? path.basename(videoRel) : null,
        poster: assetUri(baseDir, v.poster, args.embed),
        format: v.format === '16x9' ? '16x9' : '9x16',
        title: v.title || `${customer.name || 'Customer'} inbound call`,
        summary: v.summary || '',
        phoneNumber: v.phoneNumber || null,
        agentName: v.agentName || ava.name || 'Agentic Virtual Agent',
        callerName: v.callerName || 'Caller',
        capabilities: (v.capabilities || []).map((c) => ({
          at: Number(c.at) || 0,
          title: c.title || '',
          subtitle: c.subtitle || '',
        })),
        transcript: (v.transcript || []).map((t) => ({
          at: Number(t.at ?? t.start) || 0,
          speaker: t.speaker === 'caller' ? 'caller' : 'agent',
          text: stripVoiceTags(t.text ?? ''),
        })),
        outcomes: (v.outcomes || []).map((o) => ({ label: o.label, value: o.value })),
      }
    : null;

  return {
    customer: {
      name: customer.name || 'Customer',
      siteUrl: customer.siteUrl || '',
      pageImage: assetUri(baseDir, customer.pageImage, args.embed),
      logo: assetUri(baseDir, customer.logoFile, args.embed),
      // Render the logo on the background it was lifted from, so a white wordmark
      // taken off a dark site header stays visible in the widget.
      logoBackground: customer.logoBackground || '#ffffff',
      brandColor: brand,
      brandColorDark: customer.brandColorDark || brand,
    },
    ava: {
      name: ava.name || 'Virtual Assistant',
      version: ava.version ?? null,
      agentId: ava.agentId || null,
      slug: ava.slug || null,
      channel: channelKey,
    },
    copy,
    // Authors write the disclaimer either as one string or as pre-wrapped lines.
    disclaimer:
      (Array.isArray(rec.disclaimer) ? rec.disclaimer.join(' ') : rec.disclaimer) ||
      DEFAULT_DISCLAIMER,
    widget: {
      title: widget.title || `${customer.name || 'Customer'} Support`,
      subtitle: widget.subtitle || copy.subtitle,
      inputPlaceholder: widget.inputPlaceholder || copy.inputPlaceholder,
      footer: widget.footer || 'Powered by Genesys Cloud AVA',
    },
    useCases: (rec.useCases || []).map((u) => ({
      id: u.id,
      title: u.title || u.id,
      summary: u.summary || '',
      mockData: (u.mockData || []).map((d) => ({ label: d.label, value: d.value })),
    })),
    recordedAt: rec.recordedAt || new Date().toISOString(),
    messages,
    voice,
    afterContact: afterContact(rec),
  };
}

/**
 * What a supervisor sees once the interaction ends: the AI summary and the wrap-up code that
 * Genesys writes through After Contact, plus the hand-off details when the AVA passed the caller
 * to a human. After Contact runs on every interaction, not only escalations, so a contained call
 * still has a summary and a code.
 *
 * The generated summary text cannot be read back through this harness — the preview endpoint
 * returns an empty body and delivers the text on a user-scoped notification topic that client
 * credentials cannot subscribe to. So `summary.text` is written by the author, and `source` says
 * where it came from, which the page states on the panel rather than implying live output.
 */
function afterContact(rec) {
  const ac = rec.afterContact;
  if (!ac) return null;
  const s = ac.summary || {};
  const code = ac.wrapUpCode || {};
  const handoff = ac.disposition === 'handoff' ? ac.handoff || {} : null;
  return {
    source: ['org', 'captured', 'authored'].includes(ac.source) ? ac.source : 'authored',
    disposition: handoff ? 'handoff' : 'contained',
    wrapUpCode: code.name
      ? { name: String(code.name), source: code.source === 'org' ? 'org' : 'authored' }
      : null,
    handoff: handoff
      ? {
          queue: handoff.queue || null,
          reason: handoff.reason || null,
          agentSees: (handoff.agentSees || []).map((r) => ({ label: r.label, value: r.value })),
        }
      : null,
    summary: {
      settingName: s.settingName || null,
      text: s.text || '',
      reasonForCall: s.reasonForCall || '',
      resolution: s.resolution || '',
      actionItems: (s.actionItems || []).map(String),
      entities: (s.entities || []).map((e) => ({ label: e.label, value: e.value })),
    },
  };
}

/** Pick the channel to render, degrading gracefully when one side has no content. */
function resolveMode(requested, d) {
  const hasDigital = d.messages.length > 0;
  const hasVoice = !!d.voice;
  const mode = requested || 'both';

  if (mode === 'digital') {
    if (!hasDigital) throw new Error('--digital requested but the recording has no messages.');
    return 'digital';
  }
  if (mode === 'voice') {
    if (!hasVoice) {
      throw new Error(
        '--voice requested but no call video was found. Set voice.videoFile in recording.json or pass --video.'
      );
    }
    return 'voice';
  }
  if (hasDigital && hasVoice) return 'both';
  if (hasDigital) {
    console.warn('  note: no call video found — rendering the digital channel only.');
    return 'digital';
  }
  if (hasVoice) {
    console.warn('  note: no chat messages found — rendering the voice channel only.');
    return 'voice';
  }
  throw new Error('Recording has neither chat messages nor a call video — nothing to render.');
}

function buildTranscript(d, mode) {
  const lines = [];
  lines.push(`# ${d.customer.name} — AVA proof-of-concept demo transcript`);
  lines.push('');
  lines.push(`**Virtual agent:** ${d.ava.name}${d.ava.version ? ` (version ${d.ava.version})` : ''}  `);
  if (d.ava.agentId) lines.push(`**Agent ID:** \`${d.ava.agentId}\`  `);
  lines.push(`**Channel:** ${d.copy.transcriptChannel(d.customer.siteUrl)}  `);
  if (mode !== 'digital' && d.voice) lines.push('**Also included:** a recorded call video  ');
  if (mode !== 'voice') lines.push(`**Use cases covered:** ${d.useCases.length}  `);
  lines.push(`**Recorded:** ${d.recordedAt}`);
  lines.push('');
  for (const l of wrap(d.disclaimer)) lines.push(`> ${l}`);
  lines.push('');

  if (mode !== 'voice') {
    lines.push(`## ${d.copy.pill}`);
    lines.push('');

    const order = d.useCases.length
      ? d.useCases
      : [{ id: null, title: 'Conversation', summary: '', mockData: [] }];

    order.forEach((uc, i) => {
      const turns = d.messages.filter((m) => m.useCaseId === uc.id);
      if (!turns.length) return;
      lines.push(`### ${i + 1}. ${uc.title}`);
      lines.push('');
      if (uc.summary) {
        lines.push(`_${uc.summary}_`);
        lines.push('');
      }
      if (uc.mockData.length) {
        lines.push('| Demo data | Value |');
        lines.push('| --- | --- |');
        for (const row of uc.mockData) lines.push(`| ${row.label} | ${row.value} |`);
        lines.push('');
      }
      for (const m of turns) {
        for (const a of m.actions) {
          const io = [];
          if (a.input !== null) io.push(`input: \`${JSON.stringify(a.input)}\``);
          if (a.output !== null) io.push(`returned: \`${JSON.stringify(a.output)}\``);
          const status = a.status === 'ok' ? '' : ` — **${a.status}**`;
          lines.push(`- 🔧 \`${a.name}\`${status}${io.length ? ` — ${io.join(', ')}` : ''}`);
        }
        if (m.actions.length) lines.push('');
        const who = m.role === 'customer' ? 'Customer' : m.role === 'system' ? 'System' : d.ava.name;
        lines.push(`**${who}:** ${m.text}`);
        lines.push('');
        if (m.note) {
          lines.push(`> ${m.note}`);
          lines.push('');
        }
      }
    });

    const orphans = d.messages.filter((m) => !order.some((u) => u.id === m.useCaseId));
    if (orphans.length) {
      lines.push('### Other turns');
      lines.push('');
      for (const m of orphans) {
        const who = m.role === 'customer' ? 'Customer' : m.role === 'system' ? 'System' : d.ava.name;
        lines.push(`**${who}:** ${m.text}`);
        lines.push('');
      }
    }
  }

  if (mode !== 'digital' && d.voice) {
    const v = d.voice;
    lines.push('## Voice call');
    lines.push('');
    lines.push(`**Video:** \`${v.videoName || v.video}\` (${v.format})  `);
    if (v.phoneNumber) lines.push(`**Demo line:** ${v.phoneNumber}  `);
    lines.push(`**Title:** ${v.title}`);
    lines.push('');
    if (v.summary) {
      lines.push(v.summary);
      lines.push('');
    }

    if (v.capabilities.length) {
      lines.push('### Capabilities shown');
      lines.push('');
      lines.push('| Time | Capability | Moment in the call |');
      lines.push('| --- | --- | --- |');
      for (const c of v.capabilities) {
        lines.push(`| ${clock(c.at)} | ${c.title} | ${c.subtitle} |`);
      }
      lines.push('');
    }

    if (v.outcomes.length) {
      lines.push('### Business outcome');
      lines.push('');
      for (const o of v.outcomes) lines.push(`- **${o.value}** — ${o.label}`);
      lines.push('');
    }

    if (v.transcript.length) {
      lines.push('### Call transcript');
      lines.push('');
      for (const t of v.transcript) {
        const who = t.speaker === 'caller' ? v.callerName : v.agentName;
        lines.push(`**[${clock(t.at)}] ${who}:** ${t.text}`);
        lines.push('');
      }
    }
  }

  const ac = d.afterContact;
  if (ac) {
    lines.push('## After the conversation');
    lines.push('');
    lines.push('What a supervisor sees in Genesys Cloud once the interaction ends.');
    lines.push('');
    lines.push(
      ac.disposition === 'handoff'
        ? `**Disposition:** transferred to a person${ac.handoff.queue ? ` — ${ac.handoff.queue}` : ''}  `
        : '**Disposition:** resolved without a transfer  '
    );
    if (ac.wrapUpCode) lines.push(`**Wrap-up code:** ${ac.wrapUpCode.name}  `);
    if (ac.summary.settingName) lines.push(`**Summary setting:** ${ac.summary.settingName}`);
    lines.push('');
    if (ac.handoff && ac.handoff.agentSees.length) {
      lines.push('### The agent receives');
      lines.push('');
      for (const r of ac.handoff.agentSees) lines.push(`- **${r.label}:** ${r.value}`);
      lines.push('');
    }
    if (ac.summary.text) {
      lines.push(ac.summary.text);
      lines.push('');
    }
    for (const [k, val] of [
      ['Reason for call', ac.summary.reasonForCall],
      ['Resolution', ac.summary.resolution],
    ]) {
      if (val) {
        lines.push(`**${k}:** ${val}`);
        lines.push('');
      }
    }
    if (ac.summary.actionItems.length) {
      lines.push('**Next best action**');
      lines.push('');
      for (const a of ac.summary.actionItems) lines.push(`- ${a}`);
      lines.push('');
    }
    if (ac.summary.entities.length) {
      lines.push('### Extracted for the record');
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('| --- | --- |');
      for (const e of ac.summary.entities) lines.push(`| ${e.label} | ${e.value} |`);
      lines.push('');
    }
    lines.push(
      ac.source === 'captured'
        ? '_Captured from the interaction._'
        : '_Summary wording is illustrative, laid out as this org\'s summary setting defines it.' +
          (ac.wrapUpCode && ac.wrapUpCode.source === 'org'
            ? ' The wrap-up code is from the org\'s configured list._'
            : '_')
    );
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function digitalPanel(d, mode) {
  const host = (() => {
    try {
      return new URL(d.customer.siteUrl).host;
    } catch {
      return d.customer.siteUrl || d.customer.name.toLowerCase().replace(/\s+/g, '');
    }
  })();

  const chapters = d.useCases
    .map(
      (u, i) => `
      <button class="chapter" data-uc="${esc(u.id)}">
        <span class="chapter-num">${i + 1}</span>
        <span class="chapter-text">
          <span class="chapter-title">${esc(u.title)}</span>
          ${u.summary ? `<span class="chapter-sum">${esc(u.summary)}</span>` : ''}
        </span>
      </button>`
    )
    .join('');

  const pageLayer = d.customer.pageImage
    ? `<img class="page-shot" src="${esc(d.customer.pageImage)}" alt="${esc(d.customer.name)} website">`
    : `<div class="page-missing">Customer page screenshot not captured — run capture-customer-page.mjs</div>`;

  const logoMark = d.customer.logo
    ? `<img class="logo" src="${esc(d.customer.logo)}" alt="${esc(d.customer.name)}">`
    : `<span class="logo logo-text">${esc(d.customer.name)}</span>`;

  return `
<div class="stage panel" id="digitalPanel"${mode === 'voice' ? ' hidden' : ''}>
  <div>
    <div class="browser">
      <div class="browser-bar">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <div class="url">${esc(d.customer.siteUrl || host)}</div>
      </div>
      <div class="page-viewport">
        ${pageLayer}
        <div class="widget">
          <div class="w-head">
            <div class="logo-badge">${logoMark}</div>
            <div>
              <div class="w-title">${esc(d.widget.title)}</div>
              <div class="w-sub"><span class="live-dot"></span>${esc(d.widget.subtitle)}</div>
            </div>
            <div class="spacer"></div>
            <div class="w-ctl">&#8211;</div>
          </div>
          <div class="msgs" id="msgs"></div>
          <div class="composer">
            <div class="fake-input" id="composer">${esc(d.widget.inputPlaceholder)}</div>
            <div class="send">&#10148;</div>
          </div>
          <div class="w-foot">${esc(d.widget.footer)}</div>
        </div>
      </div>
    </div>

    <div class="controls">
      <button class="btn primary" id="playBtn">▶ Play</button>
      <button class="btn" id="restartBtn">↻ Restart</button>
      <div class="seg" id="speed">
        <button data-s="1" class="on">1×</button>
        <button data-s="1.5">1.5×</button>
        <button data-s="2">2×</button>
        <button data-s="4">4×</button>
      </div>
      <label class="toggle"><input type="checkbox" id="showActions" checked> Show what the AVA is doing</label>
    </div>
    <div class="progress"><span id="bar"></span></div>
  </div>

  <aside class="rail">
    <div class="card">
      <h2>Use cases</h2>
      <div id="chapters">${chapters || '<div class="mock-empty">No use cases recorded.</div>'}</div>
    </div>
    <div class="card">
      <h2>Demo data in play</h2>
      <div id="mock"><div class="mock-empty">Press play to start.</div></div>
    </div>
    ${afterContactCard(d)}
  </aside>
</div>`;
}

/**
 * The After Contact card. Dimmed until the replay finishes, because in a real interaction the
 * summary and wrap-up code are written when the conversation ends, not while it runs.
 */
function afterContactCard(d, idPrefix = '') {
  const ac = d.afterContact;
  if (!ac) return '';
  const row = (label, value) =>
    `<div class="ac-row"><span class="ac-k">${esc(label)}</span><span class="ac-v">${esc(value)}</span></div>`;

  const handoff = ac.handoff
    ? `<div class="ac-handoff">
         <div class="ac-badge">Transferred to a person</div>
         ${ac.handoff.queue ? row('Queue', ac.handoff.queue) : ''}
         ${ac.handoff.agentSees.length
           ? `<div class="ac-sub">The agent receives</div>${ac.handoff.agentSees.map((r) => row(r.label, r.value)).join('')}`
           : ''}
       </div>`
    : `<div class="ac-handoff"><div class="ac-badge contained">Resolved without a transfer</div></div>`;

  const insights = [
    ac.summary.reasonForCall ? ['Reason for call', ac.summary.reasonForCall] : null,
    ac.summary.resolution ? ['Resolution', ac.summary.resolution] : null,
  ]
    .filter(Boolean)
    .map(([k, val]) => `<div class="ac-sub">${esc(k)}</div><p class="ac-p">${esc(val)}</p>`)
    .join('');

  const actions = ac.summary.actionItems.length
    ? `<div class="ac-sub">Next best action</div><ul class="ac-list">${ac.summary.actionItems
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ul>`
    : '';

  const entities = ac.summary.entities.length
    ? `<div class="ac-sub">Extracted for the record</div>${ac.summary.entities
        .map((e) => row(e.label, e.value))
        .join('')}`
    : '';

  // Say plainly where this text came from. A supervisor-ready summary is the most convincing
  // thing on the page, so it must never be mistaken for live Genesys output when it is not.
  const provenance = {
    org: 'Wrap-up code from this org&rsquo;s configured list. Summary written for the demo.',
    captured: 'Captured from the interaction.',
    authored: 'Illustrative wording for the demo, laid out as this org&rsquo;s summary setting defines it.',
  }[ac.source];

  return `
    <div class="card ac-card" id="${idPrefix}afterContact">
      <h2>After the conversation</h2>
      <div class="ac-note">What a supervisor sees in Genesys Cloud once the interaction ends.</div>
      ${handoff}
      ${ac.wrapUpCode ? `<div class="ac-sub">Wrap-up code</div><div class="ac-code">${esc(ac.wrapUpCode.name)}</div>` : ''}
      ${ac.summary.text ? `<div class="ac-sub">Summary</div><p class="ac-p">${esc(ac.summary.text)}</p>` : ''}
      ${insights}
      ${actions}
      ${entities}
      <div class="ac-prov">${provenance}</div>
    </div>`;
}

function voicePanel(d, mode) {
  const v = d.voice;
  if (!v) return '';

  const caps = v.capabilities
    .map(
      (c, i) => `
      <button class="chapter cap" data-at="${c.at}">
        <span class="chapter-num">${i + 1}</span>
        <span class="chapter-text">
          <span class="chapter-title">${esc(c.title)}</span>
          ${c.subtitle ? `<span class="chapter-sum">${esc(c.subtitle)}</span>` : ''}
        </span>
        <span class="cap-at">${clock(c.at)}</span>
      </button>`
    )
    .join('');

  const lines = v.transcript
    .map(
      (t, i) => `
      <button class="tline ${t.speaker}" data-at="${t.at}" data-i="${i}">
        <span class="tl-at">${clock(t.at)}</span>
        <span class="tl-body">
          <span class="tl-who">${esc(t.speaker === 'caller' ? v.callerName : v.agentName)}</span>
          <span class="tl-text">${esc(t.text)}</span>
        </span>
      </button>`
    )
    .join('');

  const outcomes = v.outcomes
    .map(
      (o) => `<div class="mock-row"><span class="l">${esc(o.label)}</span><span class="v">${esc(o.value)}</span></div>`
    )
    .join('');

  return `
<div class="stage panel" id="voicePanel"${mode === 'digital' ? ' hidden' : ''}>
  <div>
    <div class="video-frame ${v.format === '16x9' ? 'wide' : 'tall'}">
      <video id="vid" controls playsinline preload="metadata"
        ${v.poster ? `poster="${esc(v.poster)}"` : ''}>
        <source src="${esc(v.video)}" type="video/mp4">
        Your browser cannot play this video. Open
        <a href="${esc(v.video)}">${esc(v.videoName || 'the MP4')}</a> directly.
      </video>
    </div>

    <div class="controls">
      <button class="btn primary" id="vPlayBtn">▶ Play</button>
      <button class="btn" id="vRestartBtn">↻ Restart</button>
      <div class="seg" id="vSpeed">
        <button data-s="0.75">0.75×</button>
        <button data-s="1" class="on">1×</button>
        <button data-s="1.25">1.25×</button>
        <button data-s="1.5">1.5×</button>
      </div>
      <label class="toggle"><input type="checkbox" id="followTranscript" checked> Follow transcript</label>
    </div>
    <div class="progress"><span id="vBar"></span></div>
    <div class="vmeta">
      <span>${esc(v.title)}</span>
      ${v.phoneNumber ? `<span class="vdot">·</span><span>Demo line ${esc(v.phoneNumber)}</span>` : ''}
      ${v.videoName ? `<span class="vdot">·</span><a class="vlink" href="${esc(v.video)}" target="_blank">Open ${esc(v.videoName)}</a>` : ''}
    </div>
  </div>

  <aside class="rail">
    ${
      caps
        ? `<div class="card"><h2>Capabilities shown</h2><div id="caps">${caps}</div></div>`
        : ''
    }
    ${
      outcomes
        ? `<div class="card"><h2>Business outcome</h2>${outcomes}</div>`
        : ''
    }
    <div class="card">
      <h2>Call transcript</h2>
      <div class="tlines" id="tlines">${lines || '<div class="mock-empty">No call transcript recorded.</div>'}</div>
    </div>
    ${afterContactCard(d, 'v')}
  </aside>
</div>`;
}

function buildHtml(d, mode) {
  const title = `${d.customer.name} — ${d.ava.name} demo`;
  const channelLabel =
    mode === 'both' ? `${d.copy.pill} + call video` : mode === 'voice' ? 'Call video' : d.copy.pill;

  const headerLine =
    mode === 'voice'
      ? 'Recorded call with the Genesys Cloud agentic virtual agent, shown as a video.'
      : mode === 'both'
        ? `${d.copy.headerLine.replace(/\.$/, '')}, plus a recorded call video.`
        : d.copy.headerLine;

  const tabs =
    mode === 'both'
      ? `
  <div class="tabs" id="tabs">
    <button class="tab on" data-panel="digitalPanel">${d.copy.tabLabel}</button>
    <button class="tab" data-panel="voicePanel">📞 Call video</button>
  </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{
    --brand:${esc(d.customer.brandColor)};
    --brand-dark:${esc(d.customer.brandColorDark)};
    --logo-bg:${esc(d.customer.logoBackground)};
    --ink:#101722; --muted:#6b7a8d; --line:#e2e8f0;
    --shell:#1b2430; --shell-2:#111823;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--shell-2); color:#e8edf4;
    font:15px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif;
    padding:28px 24px 56px;
  }
  .stage{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:1fr 320px;gap:24px;align-items:start}
  @media (max-width:1180px){.stage{grid-template-columns:1fr}}
  .panel[hidden]{display:none}

  header.demo-head{max-width:1500px;margin:0 auto 18px}
  header.demo-head h1{margin:0 0 4px;font-size:21px;letter-spacing:-.01em;font-weight:650}
  header.demo-head .sub{color:#93a2b5;font-size:13.5px}
  .pill{display:inline-block;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
    border-radius:999px;padding:2px 10px;font-size:12px;margin-right:6px}

  .tabs{max-width:1500px;margin:0 auto 16px;display:flex;gap:8px}
  .tab{background:#1b2430;border:1px solid #2a3647;color:#9fb0c4;border-radius:9px;padding:9px 18px;
    font:inherit;font-size:13.5px;cursor:pointer}
  .tab:hover{background:#222e3d}
  .tab.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}

  /* ---- browser frame around the customer page ---- */
  .browser{background:var(--shell);border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5)}
  .browser-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#263141}
  .dot{width:11px;height:11px;border-radius:50%}
  .dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
  .url{flex:1;background:#1b2430;border-radius:6px;padding:5px 12px;font-size:12.5px;color:#9fb0c4;
    margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .page-viewport{position:relative;height:min(76vh,820px);overflow:hidden;background:#fff}
  .page-shot{display:block;width:100%;height:auto}
  .page-missing{padding:80px 20px;text-align:center;color:#8a97a8;font-size:14px}
  .page-viewport::after{content:"";position:absolute;inset:0;background:linear-gradient(
    to bottom,rgba(17,24,35,0) 55%,rgba(17,24,35,.22) 100%);pointer-events:none}

  /* ---- chat widget ---- */
  .widget{position:absolute;right:26px;bottom:24px;width:390px;height:min(560px,calc(100% - 48px));
    background:#fff;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 18px 50px rgba(8,15,26,.34);z-index:3}
  .w-head{background:var(--brand);color:#fff;padding:13px 15px;display:flex;align-items:center;gap:11px}
  .logo-badge{background:var(--logo-bg);border:1px solid rgba(255,255,255,.28);border-radius:8px;
    padding:5px 9px;display:flex;align-items:center;min-width:42px;height:36px;
    justify-content:center;flex:none}
  .logo{max-height:24px;max-width:118px;display:block}
  .logo-text{color:var(--brand);font-weight:700;font-size:13px;white-space:nowrap}
  .w-title{font-weight:600;font-size:14.5px;line-height:1.2}
  .w-sub{font-size:11.5px;opacity:.85;margin-top:2px;display:flex;align-items:center;gap:5px}
  .live-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block}
  .w-head .spacer{flex:1}
  .w-ctl{opacity:.75;font-size:17px;line-height:1}

  .msgs{flex:1;overflow-y:auto;padding:16px 14px 8px;background:#f4f7fa;scroll-behavior:smooth}
  .row{display:flex;margin-bottom:10px}
  .row.me{justify-content:flex-end}
  .bubble{max-width:82%;padding:9px 13px;border-radius:15px;font-size:13.8px;line-height:1.5;
    white-space:pre-wrap;word-wrap:break-word;animation:pop .22s ease-out}
  .row.bot .bubble{background:#fff;color:var(--ink);border:1px solid var(--line);border-bottom-left-radius:5px}
  .row.me .bubble{background:var(--brand);color:#fff;border-bottom-right-radius:5px}
  .row.sys{justify-content:center}
  .row.sys .bubble{background:#e7edf4;color:#5a6b80;font-size:12px;border-radius:999px;padding:5px 13px}
  @keyframes pop{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

  .chapter-sep{display:flex;align-items:center;gap:9px;margin:16px 2px 12px;color:#8496a9;font-size:11px;
    text-transform:uppercase;letter-spacing:.07em;font-weight:600;animation:pop .22s ease-out}
  .chapter-sep::before,.chapter-sep::after{content:"";flex:1;height:1px;background:#dbe3ec}

  .act{background:#fff;border:1px solid var(--line);border-left:3px solid var(--brand);
    border-radius:9px;padding:7px 11px;margin:0 0 10px;font-size:12px;color:#44566b;animation:pop .22s ease-out}
  .act.hidden{display:none}
  .act-head{display:flex;align-items:center;gap:7px;cursor:pointer}
  .act-name{font-family:"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:var(--brand-dark);font-weight:600}
  .act-state{margin-left:auto;font-size:11px;color:#7c8b9d}
  .act.err{border-left-color:#d4553f}.act.err .act-state{color:#c0442f}
  .spin{width:11px;height:11px;border:2px solid #d8e1ea;border-top-color:var(--brand);
    border-radius:50%;animation:sp .7s linear infinite;flex:none}
  @keyframes sp{to{transform:rotate(360deg)}}
  .act-io{display:none;margin-top:7px;border-top:1px dashed var(--line);padding-top:7px}
  .act.open .act-io{display:block}
  .act-io pre{margin:3px 0 0;font:11px/1.45 "Cascadia Mono",Consolas,monospace;color:#56687c;
    background:#f6f9fc;padding:6px 8px;border-radius:5px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  .act-io .k{color:#8496a9;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}

  .typing{display:inline-flex;gap:4px;padding:11px 14px;background:#fff;border:1px solid var(--line);
    border-radius:15px;border-bottom-left-radius:5px}
  .typing i{width:6px;height:6px;border-radius:50%;background:#aebccb;animation:bob 1.1s infinite}
  .typing i:nth-child(2){animation-delay:.16s}.typing i:nth-child(3){animation-delay:.32s}
  @keyframes bob{0%,60%,100%{transform:translateY(0);opacity:.55}30%{transform:translateY(-4px);opacity:1}}

  .composer{border-top:1px solid var(--line);background:#fff;padding:9px 12px;display:flex;
    align-items:center;gap:9px;flex:none}
  .fake-input{flex:1;background:#f1f5f9;border-radius:999px;padding:8px 14px;font-size:13px;color:#90a0b2;
    min-height:34px;display:flex;align-items:center}
  .fake-input.active{color:var(--ink)}
  .caret{display:inline-block;width:1.5px;height:15px;background:var(--brand);margin-left:1px;
    animation:blink 1s step-end infinite;vertical-align:middle}
  @keyframes blink{50%{opacity:0}}
  .send{width:32px;height:32px;border-radius:50%;background:var(--brand);color:#fff;display:flex;
    align-items:center;justify-content:center;flex:none;font-size:14px}
  .w-foot{text-align:center;font-size:10.5px;color:#9aa8b8;padding:5px 0 8px;background:#fff;flex:none}

  /* ---- voice panel ---- */
  .video-frame{background:#000;border-radius:12px;overflow:hidden;display:flex;justify-content:center;
    box-shadow:0 24px 60px rgba(0,0,0,.5)}
  .video-frame video{display:block;max-width:100%;background:#000}
  .video-frame.tall video{height:min(76vh,860px);width:auto}
  .video-frame.wide video{width:100%;height:auto}
  .vmeta{margin-top:11px;color:#8c9db1;font-size:12.5px;display:flex;flex-wrap:wrap;gap:7px;align-items:center}
  .vdot{opacity:.5}
  .vlink{color:var(--brand);text-decoration:none}
  .vlink:hover{text-decoration:underline}
  .cap-at{margin-left:auto;font-family:"Cascadia Mono",Consolas,monospace;font-size:11px;opacity:.75;
    padding-top:2px}
  .chapter.cap{align-items:center}

  .tlines{max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;scroll-behavior:smooth}
  .tline{display:flex;gap:9px;width:100%;text-align:left;background:none;border:none;color:#aebccb;
    padding:6px 8px;border-radius:7px;cursor:pointer;font:inherit;font-size:12.5px;align-items:flex-start}
  .tline:hover{background:#222e3d}
  .tline.on{background:#243141;color:#eef3f9}
  .tline.on .tl-who{color:var(--brand)}
  .tl-at{font-family:"Cascadia Mono",Consolas,monospace;font-size:10.5px;opacity:.6;flex:none;padding-top:2px}
  .tl-body{display:flex;flex-direction:column;gap:1px}
  .tl-who{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#7e8fa3;font-weight:600}
  .tline.caller .tl-who{color:#8fa4bb}
  .tl-text{line-height:1.4}

  /* ---- side rail ---- */
  .rail{display:flex;flex-direction:column;gap:14px;position:sticky;top:28px}
  .card{background:#1b2430;border:1px solid #2a3647;border-radius:11px;padding:14px}
  .card h2{margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:#8c9db1;font-weight:600}
  .chapter{display:flex;gap:10px;width:100%;text-align:left;background:none;border:none;color:#c3cedb;
    padding:8px 9px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;align-items:flex-start}
  .chapter:hover{background:#222e3d}
  .chapter.active{background:var(--brand);color:#fff}
  .chapter.done .chapter-num{background:#3c4c61;color:#cdd8e4}
  .chapter.active .chapter-num{background:rgba(255,255,255,.22);color:#fff}
  .chapter-num{flex:none;width:21px;height:21px;border-radius:50%;background:#2a3647;color:#93a4b8;
    font-size:11.5px;display:flex;align-items:center;justify-content:center;margin-top:1px;font-weight:600}
  .chapter-text{display:flex;flex-direction:column;gap:2px}
  .chapter-title{font-weight:550;line-height:1.3}
  .chapter-sum{font-size:11.5px;opacity:.72;line-height:1.35}

  .mock-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:5px 0;
    border-bottom:1px solid #26313f}
  .mock-row:last-child{border-bottom:none}
  .mock-row .l{color:#8c9db1}
  .mock-row .v{font-family:"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:#dbe4ee;text-align:right}
  .mock-empty{color:#6e7f93;font-size:12.5px}

  /* ---- after contact ---- */
  .ac-card{opacity:.4;transition:opacity .45s ease}
  .ac-card.on{opacity:1}
  .ac-note{color:#6e7f93;font-size:11.5px;line-height:1.45;margin:-4px 0 11px}
  .ac-handoff{margin-bottom:11px}
  .ac-badge{display:inline-block;background:#3b2a16;border:1px solid #7a5520;color:#f0b254;
    border-radius:999px;padding:3px 11px;font-size:11.5px;font-weight:600;margin-bottom:7px}
  .ac-badge.contained{background:#16302a;border-color:#1f6a53;color:#4fd1a5}
  .ac-sub{color:#8c9db1;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
    font-weight:600;margin:12px 0 5px}
  .ac-p{margin:0;font-size:12.5px;line-height:1.5;color:#cdd8e4}
  .ac-list{margin:0;padding-left:16px;font-size:12.5px;line-height:1.55;color:#cdd8e4}
  .ac-code{display:inline-block;background:#1f2a38;border:1px solid #3a4b61;border-radius:7px;
    padding:5px 11px;font-family:"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:#9fd2ff}
  .ac-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:5px 0;
    border-bottom:1px solid #26313f}
  .ac-row:last-child{border-bottom:none}
  .ac-k{color:#8c9db1}
  .ac-v{color:#dbe4ee;text-align:right}
  .ac-prov{margin-top:13px;padding-top:10px;border-top:1px solid #26313f;color:#6e7f93;
    font-size:11px;line-height:1.45}

  /* ---- controls ---- */
  .controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}
  .btn{background:#222e3d;border:1px solid #334155;color:#dbe4ee;border-radius:8px;padding:7px 14px;
    font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{background:#2b3a4c}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff;min-width:104px;justify-content:center}
  .seg{display:flex;border:1px solid #334155;border-radius:8px;overflow:hidden}
  .seg button{background:#222e3d;border:none;color:#9fb0c4;padding:7px 12px;font:inherit;font-size:12.5px;cursor:pointer}
  .seg button.on{background:var(--brand);color:#fff}
  .toggle{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#9fb0c4;cursor:pointer;
    margin-left:auto;user-select:none}
  .toggle input{accent-color:var(--brand);width:15px;height:15px}
  .progress{height:3px;background:#2a3647;border-radius:2px;overflow:hidden;margin-top:12px}
  .progress span{display:block;height:100%;width:0;background:var(--brand);transition:width .25s linear}
  footer.note{max-width:1500px;margin:26px auto 0;color:#6e7f93;font-size:12px}
</style>
</head>
<body>

<header class="demo-head">
  <h1>${esc(d.customer.name)} — ${esc(d.ava.name)}</h1>
  <div class="sub">
    <span class="pill">Proof of concept</span>
    <span class="pill">${esc(channelLabel)}</span>
    ${mode !== 'voice' ? `<span class="pill">${d.useCases.length} use case${d.useCases.length === 1 ? '' : 's'}</span>` : ''}
    <span class="pill">Mock data</span>
    ${d.ava.version ? `<span class="pill">v${esc(d.ava.version)}</span>` : ''}
    ${esc(headerLine)}
  </div>
</header>
${tabs}
${mode !== 'voice' ? digitalPanel(d, mode) : ''}
${mode !== 'digital' ? voicePanel(d, mode) : ''}

<footer class="note">
  ${esc(d.ava.name)}${d.ava.version ? ` v${esc(d.ava.version)}` : ''} · recorded ${esc(d.recordedAt)}<br>
  ${esc(d.disclaimer)}
</footer>

<script id="payload" type="application/json">${jsonForScript({ ...d, copy: undefined })}</script>
<script>
(function(){
  "use strict";
  var D = JSON.parse(document.getElementById('payload').textContent);
  var MODE = ${JSON.stringify(mode)};

  function escape_(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  /* ================= digital channel ================= */
  var chat = null;
  if (MODE !== 'voice') chat = (function(){
    var msgsEl = document.getElementById('msgs');
    var composer = document.getElementById('composer');
    var playBtn = document.getElementById('playBtn');
    var restartBtn = document.getElementById('restartBtn');
    var showActions = document.getElementById('showActions');
    var bar = document.getElementById('bar');
    var mockEl = document.getElementById('mock');
    var chapterEls = Array.prototype.slice.call(document.querySelectorAll('#chapters .chapter'));

    var speed = 1, paused = true, runToken = 0, finished = false;
    var ABORT = {};

    // After Contact is written when the interaction ends, so the card stays dimmed until it does.
    var acCard = document.getElementById('afterContact');
    function setAfterContact(on){ if (acCard) acCard.classList.toggle('on', !!on); }

    function readMs(text){ return clamp(text.length * 26, 700, 2600); }
    function typeMs(text){ return clamp(text.length * 17, 600, 2400); }

    /** Wait that honours live pause and speed changes, and aborts on restart/seek. */
    function wait(ms){
      var token = runToken, elapsed = 0, TICK = 40;
      return new Promise(function(resolve, reject){
        (function tick(){
          if (token !== runToken) return reject(ABORT);
          if (elapsed >= ms) return resolve();
          setTimeout(function(){
            if (token !== runToken) return reject(ABORT);
            if (!paused) elapsed += TICK * speed;
            tick();
          }, TICK);
        })();
      });
    }

    function scroll(){ msgsEl.scrollTop = msgsEl.scrollHeight; }

    function addSeparator(title){
      var el = document.createElement('div');
      el.className = 'chapter-sep';
      el.textContent = title;
      msgsEl.appendChild(el); scroll();
    }

    function addBubble(role, text){
      var row = document.createElement('div');
      row.className = 'row ' + (role === 'customer' ? 'me' : role === 'system' ? 'sys' : 'bot');
      var b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text;
      row.appendChild(b); msgsEl.appendChild(row); scroll();
    }

    function fmt(v){ return escape_(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }

    function addAction(a){
      var el = document.createElement('div');
      el.className = 'act' + (a.status !== 'ok' ? ' err' : '') + (showActions.checked ? '' : ' hidden');
      var io = '';
      if (a.input !== null && a.input !== undefined) io += '<div class="k">sent</div><pre>' + fmt(a.input) + '</pre>';
      if (a.output !== null && a.output !== undefined) io += '<div class="k">returned</div><pre>' + fmt(a.output) + '</pre>';
      el.innerHTML =
        '<div class="act-head"><span class="spin"></span>' +
        '<span class="act-name">' + escape_(a.name) + '</span>' +
        '<span class="act-state">calling…</span></div>' +
        (io ? '<div class="act-io">' + io + '</div>' : '');
      el.querySelector('.act-head').addEventListener('click', function(){
        if (io) el.classList.toggle('open');
      });
      msgsEl.appendChild(el); scroll();
      return el;
    }

    function resolveAction(el, a){
      var head = el.querySelector('.act-head');
      var ok = a.status === 'ok';
      head.querySelector('.spin').outerHTML =
        '<span style="font-size:12px;color:' + (ok ? '#2f9e68' : '#c0442f') + '">' + (ok ? '✓' : '!') + '</span>';
      head.querySelector('.act-state').textContent =
        (ok ? (a.label || 'returned') : a.status) + (el.querySelector('.act-io') ? ' · details' : '');
    }

    function showTyping(){
      var row = document.createElement('div');
      row.className = 'row bot';
      row.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
      msgsEl.appendChild(row); scroll();
      return row;
    }

    /** Character-by-character fill of the fake composer, as if the customer were typing. */
    function customerTyping(text){
      var token = runToken;
      composer.classList.add('active');
      var shown = 0, total = text.length, step = Math.max(1, Math.round(total / 34));
      return new Promise(function(resolve, reject){
        (function tick(){
          if (token !== runToken) return reject(ABORT);
          if (shown >= total){
            composer.innerHTML = escape_(text) + '<span class="caret"></span>';
            return resolve();
          }
          setTimeout(function(){
            if (token !== runToken) return reject(ABORT);
            if (!paused){
              shown = Math.min(total, shown + step);
              composer.innerHTML = escape_(text.slice(0, shown)) + '<span class="caret"></span>';
            }
            tick();
          }, Math.max(14, 34 / speed));
        })();
      });
    }

    function clearComposer(){
      composer.classList.remove('active');
      composer.textContent = D.widget.inputPlaceholder;
    }

    function useCaseById(id){
      for (var i = 0; i < D.useCases.length; i++) if (D.useCases[i].id === id) return D.useCases[i];
      return null;
    }

    function setChapter(id){
      var idx = -1;
      chapterEls.forEach(function(el, i){ if (el.getAttribute('data-uc') === id) idx = i; });
      chapterEls.forEach(function(el, i){
        el.classList.toggle('active', i === idx);
        el.classList.toggle('done', idx > -1 && i < idx);
      });
      var uc = useCaseById(id);
      if (!uc || !uc.mockData.length){
        mockEl.innerHTML = '<div class="mock-empty">No demo data for this use case.</div>';
        return;
      }
      mockEl.innerHTML = uc.mockData.map(function(r){
        return '<div class="mock-row"><span class="l">' + escape_(r.label) +
               '</span><span class="v">' + escape_(r.value) + '</span></div>';
      }).join('');
    }

    /** Render a message with no animation — used when seeking to a chapter. */
    function renderInstant(m, prevUc){
      if (m.useCaseId !== prevUc){
        var uc = useCaseById(m.useCaseId);
        if (uc) addSeparator(uc.title);
      }
      m.actions.forEach(function(a){ resolveAction(addAction(a), a); });
      addBubble(m.role, m.text);
    }

    function setProgress(i){
      bar.style.width = (D.messages.length ? (i / D.messages.length) * 100 : 0) + '%';
    }

    function setPlayLabel(){
      playBtn.textContent = finished ? '↻ Replay' : (paused ? '▶ Play' : '❚❚ Pause');
    }

    async function run(fromIndex){
      var token = ++runToken;
      finished = false;
      setAfterContact(false);
      msgsEl.innerHTML = '';
      clearComposer();

      var prevUc = null;
      for (var i = 0; i < fromIndex; i++){
        renderInstant(D.messages[i], prevUc);
        prevUc = D.messages[i].useCaseId;
      }
      if (prevUc !== null) setChapter(prevUc);
      setProgress(fromIndex);

      try {
        for (var j = fromIndex; j < D.messages.length; j++){
          if (token !== runToken) return;
          var m = D.messages[j];

          if (m.useCaseId !== prevUc){
            var uc = useCaseById(m.useCaseId);
            if (uc) addSeparator(uc.title);
            setChapter(m.useCaseId);
            prevUc = m.useCaseId;
            await wait(500);
          }

          if (m.role === 'customer'){
            await wait(450);
            await customerTyping(m.text);
            await wait(260);
            clearComposer();
            addBubble('customer', m.text);
            await wait(420);
          } else if (m.role === 'system'){
            addBubble('system', m.text);
            await wait(700);
          } else {
            for (var k = 0; k < m.actions.length; k++){
              var a = m.actions[k];
              var el = addAction(a);
              await wait(850);
              resolveAction(el, a);
              await wait(260);
            }
            var t = showTyping();
            await wait(typeMs(m.text));
            t.remove();
            addBubble('agent', m.text);
            await wait(readMs(m.text));
          }
          setProgress(j + 1);
        }
        finished = true;
        paused = true;
        setAfterContact(true);
        setPlayLabel();
      } catch (e) {
        if (e !== ABORT) throw e;
      }
    }

    playBtn.addEventListener('click', function(){
      if (finished){ finished = false; paused = false; setPlayLabel(); run(0); return; }
      if (runToken === 0){ paused = false; setPlayLabel(); run(0); return; }
      paused = !paused;
      setPlayLabel();
    });

    restartBtn.addEventListener('click', function(){
      paused = false; finished = false; setPlayLabel(); run(0);
    });

    document.getElementById('speed').addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b) return;
      speed = parseFloat(b.getAttribute('data-s'));
      Array.prototype.forEach.call(this.children, function(c){ c.classList.toggle('on', c === b); });
    });

    showActions.addEventListener('change', function(){
      Array.prototype.forEach.call(msgsEl.querySelectorAll('.act'), function(el){
        el.classList.toggle('hidden', !showActions.checked);
      });
      scroll();
    });

    chapterEls.forEach(function(el){
      el.addEventListener('click', function(){
        var id = el.getAttribute('data-uc'), start = 0;
        for (var i = 0; i < D.messages.length; i++){
          if (D.messages[i].useCaseId === id){ start = i; break; }
        }
        paused = false; finished = false; setPlayLabel(); run(start);
      });
    });

    // Idle state: greeting visible, waiting for the presenter to hit play.
    var first = D.messages[0];
    if (first && first.role === 'agent') addBubble('agent', first.text);
    if (D.useCases.length) setChapter(D.useCases[0].id);
    setPlayLabel();

    return { pause: function(){ paused = true; setPlayLabel(); } };
  })();

  /* ================= voice channel ================= */
  var voice = null;
  if (MODE !== 'digital' && D.voice) voice = (function(){
    var V = D.voice;
    var vid = document.getElementById('vid');
    var playBtn = document.getElementById('vPlayBtn');
    var restartBtn = document.getElementById('vRestartBtn');
    var follow = document.getElementById('followTranscript');
    var bar = document.getElementById('vBar');
    var capEls = Array.prototype.slice.call(document.querySelectorAll('#caps .cap'));
    var lineEls = Array.prototype.slice.call(document.querySelectorAll('#tlines .tline'));
    var linesBox = document.getElementById('tlines');

    function label(){ playBtn.textContent = vid.paused ? '▶ Play' : '❚❚ Pause'; }

    playBtn.addEventListener('click', function(){
      if (vid.paused) vid.play(); else vid.pause();
    });
    restartBtn.addEventListener('click', function(){
      vid.currentTime = 0; vid.play();
    });
    vid.addEventListener('play', label);
    vid.addEventListener('pause', label);
    var vAc = document.getElementById('vafterContact');
    vid.addEventListener('ended', function(){
      playBtn.textContent = '↻ Replay';
      if (vAc) vAc.classList.add('on');
    });
    // Scrubbing back from the end puts the call mid-flight again, so the card dims with it.
    vid.addEventListener('seeking', function(){
      if (vAc && vid.currentTime < vid.duration - 0.5) vAc.classList.remove('on');
    });

    document.getElementById('vSpeed').addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b) return;
      vid.playbackRate = parseFloat(b.getAttribute('data-s'));
      Array.prototype.forEach.call(this.children, function(c){ c.classList.toggle('on', c === b); });
    });

    function seek(sec){
      vid.currentTime = sec;
      if (vid.paused) vid.play();
    }
    capEls.forEach(function(el){
      el.addEventListener('click', function(){ seek(parseFloat(el.getAttribute('data-at'))); });
    });
    lineEls.forEach(function(el){
      el.addEventListener('click', function(){ seek(parseFloat(el.getAttribute('data-at'))); });
    });

    /** Highlight the capability and transcript line covering the playhead. */
    function activeIndex(list, t){
      var idx = -1;
      for (var i = 0; i < list.length; i++){
        if (parseFloat(list[i].getAttribute('data-at')) <= t + 0.01) idx = i; else break;
      }
      return idx;
    }

    vid.addEventListener('timeupdate', function(){
      var t = vid.currentTime;
      if (vid.duration) bar.style.width = (t / vid.duration) * 100 + '%';

      var ci = activeIndex(capEls, t);
      capEls.forEach(function(el, i){
        el.classList.toggle('active', i === ci);
        el.classList.toggle('done', ci > -1 && i < ci);
      });

      var li = activeIndex(lineEls, t);
      lineEls.forEach(function(el, i){ el.classList.toggle('on', i === li); });
      if (li > -1 && follow.checked){
        var el = lineEls[li];
        var top = el.offsetTop - linesBox.clientHeight / 2 + el.clientHeight / 2;
        linesBox.scrollTop = Math.max(0, top);
      }
    });

    label();
    return { pause: function(){ vid.pause(); } };
  })();

  /* ================= channel switcher ================= */
  var tabs = document.getElementById('tabs');
  if (tabs) tabs.addEventListener('click', function(e){
    var b = e.target.closest('.tab'); if (!b) return;
    var target = b.getAttribute('data-panel');
    // Leaving a channel always stops it, so two demos never play over each other.
    if (chat) chat.pause();
    if (voice) voice.pause();
    Array.prototype.forEach.call(this.children, function(c){ c.classList.toggle('on', c === b); });
    ['digitalPanel','voicePanel'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.hidden = (id !== target);
    });
  });
})();
</script>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.recording) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.recording)) {
    console.error(`Recording not found: ${args.recording}`);
    process.exit(1);
  }

  const baseDir = path.dirname(args.recording);
  const outDir = args.outDir || baseDir;
  const raw = JSON.parse(fs.readFileSync(args.recording, 'utf8').replace(/^\uFEFF/, ''));
  const data = normalize(raw, baseDir, args);

  let mode;
  try {
    mode = resolveMode(args.mode, data);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'demo.html');
  const mdPath = path.join(outDir, 'transcript.md');
  fs.writeFileSync(htmlPath, buildHtml(data, mode), 'utf8');
  fs.writeFileSync(mdPath, buildTranscript(data, mode), 'utf8');

  console.log(`Demo built for ${data.customer.name} — ${mode} channel${mode === 'both' ? 's' : ''}`);
  if (mode !== 'voice') {
    const tools = data.messages.reduce((n, m) => n + m.actions.length, 0);
    console.log(
      `  web chat    ${data.useCases.length} use cases · ${data.messages.length} turns · ${tools} tool call${tools === 1 ? '' : 's'}`
    );
  }
  if (mode !== 'digital' && data.voice) {
    console.log(
      `  voice       ${data.voice.videoName || 'video'} (${data.voice.format}) · ` +
        `${data.voice.capabilities.length} capabilities · ${data.voice.transcript.length} lines` +
        (args.embedVideo ? ' · embedded' : ' · linked')
    );
  }
  console.log(`  demo.html   ${htmlPath}${args.embed ? ' (images inlined)' : ''}`);
  console.log(`  transcript  ${mdPath}`);

  // Bundle in place so the folder is always handoff-ready, and so a linked MP4 and the
  // rest of assets/ can never get separated from demo.html in transit.
  if (args.zip) {
    try {
      const bundle = zipDemo({ demoDir: outDir });
      console.log(`  demo.zip    ${bundle.outFile} (${bundle.sizeKb} KB)`);
      console.log(`              ${bundle.items.join(', ')}`);
      if (bundle.sizeKb > 20000) {
        console.log('  note: over 20 MB — share the bundle as a link rather than an attachment.');
      }
    } catch (err) {
      console.warn(`  warning: could not write demo.zip (${err.message.split('\n')[0]})`);
    }
  }

  if (mode !== 'digital' && !args.embedVideo) {
    console.log('  note: the MP4 is linked — send demo.zip, or keep demo.html beside assets/.');
  }
}

main();
