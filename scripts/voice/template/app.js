'use strict';

/**
 * app.js — the deterministic render engine.
 *
 * render(t) must depend on nothing but t: no real timers, no CSS animations, no randomness.
 * The frame renderer screenshots the page after calling render(f/30), so anything time-dependent
 * that it cannot see would tear or jitter in the encode.
 */

const D = window.DATA;
const S = window.SCENES;
const A = window.ASSETS || {};

/* ------------------------------------------------------------------ timeline */

const INTRO = 6.0;      // must match the adelay applied to the audio at encode time
const CROSSFADE = 3.9;  // beige intro gives way to the "answering" card
const HOLD = 1.6;
const RECAP = 8.5;
const OUTCOME = 6.5;
const OUTRO = 5.5;
const CTA = 9.0;

const CALL_END = INTRO + D.callDur;
const T_RECAP = CALL_END + HOLD;
const T_OUTCOME = T_RECAP + RECAP;
const T_OUTRO = T_OUTCOME + OUTCOME;
const T_CTA = T_OUTRO + OUTRO;
const TOTAL = T_CTA + CTA;
window.TOTAL = TOTAL;
window.INTRO = INTRO;
// Scene boundaries, so the contact sheet can sample one frame inside each scene rather than
// spreading samples evenly and missing the short ones.
window.MARKS = { intro: 0, answering: CROSSFADE, call: INTRO, callEnd: CALL_END,
  recap: T_RECAP, outcome: T_OUTCOME, outro: T_OUTRO, cta: T_CTA, total: TOTAL };

/* ------------------------------------------------------------------- helpers */

const ease = (x) => (x < 0 ? 0 : x > 1 ? 1 : 1 - Math.pow(1 - x, 3));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Fade in over d, hold, fade out over d. Returns 0 outside the window. */
function vis(t, a, b, d = 0.4) {
  if (t < a || t > b + d) return 0;
  return Math.min(ease((t - a) / d), 1 - ease((t - b) / d));
}

/** Original-audio seconds to output seconds. Identity for synthesized audio. */
function fwd(o) {
  for (const [os, s, dur] of D.map) {
    if (o < s) return os;
    if (o <= s + dur) return os + (o - s);
  }
  const last = D.map[D.map.length - 1];
  return last[0] + last[2];
}

const $ = (sel) => document.querySelector(sel);

/** Fade an element and slide it up 28px as it arrives, per the layout spec. */
function show(el, v, slide = true) {
  el.style.opacity = v;
  if (slide) el.style.transform = `translateY(${(1 - v) * 28}px)`;
}

function wordmark(el, text) {
  if (A.genesysLogo) {
    el.innerHTML = `<img src="${A.genesysLogo}" alt="Genesys" style="width:100%;height:100%;object-fit:contain">`;
  } else {
    // No supplied brand asset, so set the wordmark as type. Sizing stays in the stylesheet.
    el.textContent = text;
  }
}

function img(el, src) {
  if (!src) { el.style.display = 'none'; return; }
  el.src = src;
}

/* ---------------------------------------------------------------- build once */

document.body.classList.toggle('land', S.format === '16x9');
const W = S.format === '16x9' ? 1920 : 1080;
const H = S.format === '16x9' ? 1080 : 1920;

const bgBeige = $('#bgBeige');
const waves = $('#waves');
waves.width = W;
waves.height = H;
const wx = waves.getContext('2d');

img($('#introLogo'), A.customerLogo);
if (A.customerLogo && S.logoBackground) {
  Object.assign($('#introLogo').style, {
    background: S.logoBackground,
    padding: '28px 44px',
    borderRadius: '22px',
  });
}
img($('#introPartner'), A.partnerLogo);
img($('#ctaPartner'), A.partnerLogo);
wordmark($('#introGenesys'), 'Genesys');
wordmark($('#outroGenesys'), 'Genesys');
wordmark($('#ctaGenesys'), 'Genesys');

$('#introTitle').textContent = S.intro.title;
$('#introLine1').textContent = S.intro.line1;
$('#introLine2').textContent = S.intro.line2;
$('#introContext').textContent = S.intro.context;
$('#inbound .lbl').textContent = S.intro.inboundLabel;

$('#names .n1').textContent = S.agentName;
$('#names .r1').textContent = S.agentRole;
$('#names .n2').textContent = S.callerName;
$('#agentAv .face').innerHTML = A.agentGlyph
  ? `<img src="${A.agentGlyph}" alt="">`
  : '<span style="color:#ff5a1f">◉</span>';
$('#callerAv .face').textContent = (S.callerName || 'C').trim().charAt(0).toUpperCase();

for (let i = 0; i < 14; i += 1) $('#bars').appendChild(document.createElement('i'));
const bars = [...document.querySelectorAll('#bars i')];

// Cards are built once and only their opacity changes per frame.
// Slot 1 has to clear the avatars at y=880, so it sits high enough for a three-row card.
const SLOT_TOP = S.format === '16x9' ? [60, 420] : [262, 548];
const cardEls = S.cards.map((c) => {
  const el = document.createElement('div');
  el.className = `card ${c.cls || ''}`;
  el.style.top = `${SLOT_TOP[c.slot || 0]}px`;
  const rows = (c.rows || [])
    .map((r) => `<div class="row"><span>${r.label}</span><span class="v">${r.value}</span></div>`)
    .join('');
  el.innerHTML = `<div class="ttl">${c.action ? '⚡ ' : ''}${c.title || ''}</div>${rows}`;
  $('#cardSlots').appendChild(el);
  return el;
});

$('#recapLead').textContent = S.recap.lead;
$('#recapList').innerHTML = S.recap.lines
  .map((l) => `<div class="li"><span class="ck">✓</span><span>${l}</span></div>`)
  .join('');
const recapRows = [...document.querySelectorAll('#recapList .li')];

$('#outLine').innerHTML = `${S.outcome.line1}<br><span class="grad">${S.outcome.line2}</span>`;
$('#tiles').innerHTML = S.outcome.tiles
  .map((t) => `<div class="tile"><div class="v">${t.value}</div><div class="l">${t.label}</div></div>`)
  .join('');
const tileEls = [...document.querySelectorAll('#tiles .tile')];

$('#outroLines').innerHTML =
  `${S.outro.line1}<br><span class="grad">${S.outro.line2}</span><br>${S.outro.line3}`;
$('#outroPill span').textContent = S.outro.pill;

$('#ctaEyebrow').textContent = S.cta.eyebrow;
$('#ctaTitle').innerHTML = `${S.cta.line1}<br><span class="grad">${S.cta.line2}</span>`;
$('#ctaNote').textContent = S.cta.note;
if (S.cta.phone) $('#phoneTile .num').textContent = S.cta.phone;
else $('#phoneTile').style.display = 'none';

/* --------------------------------------------------------------- captions */

/** Split a line into caption chunks of at most 40 characters, breaking at sentence ends. */
function chunk(text) {
  const out = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > 40 && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = next;
    }
    if (/[.?!]$/.test(cur) && cur.length > 16) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Each chunk gets a share of its segment proportional to its character count, then both ends go
// through fwd() so a cut inside a segment cannot drift out of sync.
const CAPTIONS = [];
for (const seg of D.segs) {
  const chunks = chunk(seg.text);
  const chars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  const dur = seg.end - seg.start;
  let acc = 0;
  for (const c of chunks) {
    const a = seg.start + (dur * acc) / chars;
    acc += c.length;
    const b = seg.start + (dur * acc) / chars;
    CAPTIONS.push({ a: fwd(a), b: fwd(b), text: c, ch: seg.ch });
  }
}

/* ------------------------------------------------------------------- waves */

function drawWaves(t, alpha, band) {
  wx.clearRect(0, 0, W, H);
  if (alpha <= 0) return;
  const colors = ['#ff5a1f', '#f5b335', '#e8435a', '#3fc8b0', '#4f7cff'];
  // Subtle enough that captions and cards stay the focus.
  wx.globalAlpha = alpha * 0.22;
  wx.lineWidth = 2;
  for (let i = 0; i < 26; i += 1) {
    wx.beginPath();
    wx.strokeStyle = colors[i % colors.length];
    const amp = 26 + (i % 7) * 9;
    const phase = t * 0.25 + i * 0.37;
    const y0 = band[0] + ((band[1] - band[0]) * i) / 26;
    for (let x = 0; x <= W; x += 12) {
      const y = y0 + Math.sin(x / 190 + phase) * amp + Math.sin(x / 70 - phase * 1.4) * (amp / 4);
      if (x === 0) wx.moveTo(x, y);
      else wx.lineTo(x, y);
    }
    wx.stroke();
  }
  wx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ render */

const sections = {
  intro: $('#sc-intro'),
  call: $('#sc-call'),
  recap: $('#sc-recap'),
  outcome: $('#sc-outcome'),
  outro: $('#sc-outro'),
  cta: $('#sc-cta'),
};

window.render = function render(t) {
  // Scene opacity. The intro crossfades into the call screen rather than cutting.
  const introOut = vis(t, 0, CROSSFADE, 0.5);
  const outroV = vis(t, T_OUTRO, T_CTA - 0.4, 0.5);
  sections.intro.style.opacity = introOut;
  sections.call.style.opacity = t < CROSSFADE ? 0 : vis(t, CROSSFADE, CALL_END + HOLD - 0.4, 0.5);
  sections.recap.style.opacity = vis(t, T_RECAP, T_OUTCOME - 0.4, 0.5);
  sections.outcome.style.opacity = vis(t, T_OUTCOME, T_OUTRO - 0.4, 0.5);
  sections.outro.style.opacity = outroV;
  sections.cta.style.opacity = vis(t, T_CTA, TOTAL, 0.5);

  // The beige backdrop crossfades over the dark one; the waves sit between backdrop and content.
  const beige = Math.max(introOut, outroV);
  bgBeige.style.opacity = beige;
  drawWaves(t, 1, beige > 0.5 ? [H - 260, H - 40] : [H * 0.52, H * 0.98]);

  if (t < CROSSFADE + 0.6) {
    show($('#introLogo'), vis(t, 0.2, CROSSFADE), false);
    show($('#introEyebrow'), vis(t, 0.8, CROSSFADE));
    show($('#introGenesys'), vis(t, 0.8, CROSSFADE), false);
    show($('#introTitle'), vis(t, 1.2, CROSSFADE));
    show($('#introLine1'), vis(t, 1.8, CROSSFADE));
    show($('#introLine2'), vis(t, 2.1, CROSSFADE));
    show($('#introContext'), vis(t, 2.6, CROSSFADE));
    show($('#introPartner'), vis(t, 3.0, CROSSFADE), false);
  }

  // --- call screen -----------------------------------------------------------

  const inbound = $('#inbound');
  const inboundV = vis(t, CROSSFADE + 0.1, INTRO - 0.3, 0.4);
  show(inbound, inboundV);
  inbound.querySelector('.ring').style.transform = `scale(${1 + 0.08 * Math.sin(t * 4)})`;

  const tc = t - INTRO;            // seconds into the call audio
  const live = tc >= 0 && tc <= D.callDur;
  const callUi = clamp((tc + 0.3) / 0.5, 0, 1) * (1 - inboundV);

  const timer = $('#timer');
  timer.style.opacity = callUi;
  const shown = clamp(tc, 0, D.callDur);
  const mm = Math.floor(shown / 60);
  const ss = String(Math.floor(shown % 60)).padStart(2, '0');
  timer.classList.toggle('ended', tc > D.callDur);
  timer.querySelector('.txt').textContent = tc > D.callDur ? 'Call ended' : `Live call ${mm}:${ss}`;

  // One chip at a time; the last one whose window contains tc wins.
  const chipEl = $('#chip');
  let chipV = 0;
  for (const c of S.chips) {
    const v = vis(tc, c.at, c.until);
    if (v > 0) {
      chipV = v;
      chipEl.querySelector('.badge').textContent = `✓  ${c.text}`;
      chipEl.classList.toggle('warn', c.tone === 'warn');
    }
  }
  show(chipEl, chipV * callUi);

  S.cards.forEach((c, i) => show(cardEls[i], vis(tc, c.at, c.until) * callUi));

  // Who is speaking right now drives the avatars, the tag and the waveform colour.
  const seg = D.segs.find((s) => tc >= s.start && tc <= s.end);
  const agentTalking = !!seg && seg.ch === 'R';
  const callerTalking = !!seg && seg.ch === 'L';

  const agentAv = $('#agentAv');
  const callerAv = $('#callerAv');
  agentAv.style.opacity = callUi;
  callerAv.style.opacity = callUi;
  agentAv.querySelector('.ring2').style.transform = `rotate(${t * 60}deg)`;
  agentAv.style.boxShadow = agentTalking ? '0 0 70px 14px rgba(255,90,31,.55)' : 'none';
  callerAv.style.boxShadow = callerTalking ? '0 0 70px 14px rgba(255,255,255,.4)' : 'none';

  const frame = Math.floor(clamp(tc, 0, D.callDur) * 30);
  const level = live ? (D.env.R[frame] || 0) + (D.env.L[frame] || 0) : 0;
  bars.forEach((b, i) => {
    const wobble = 0.55 + 0.45 * Math.sin(t * 9 + i * 1.7);
    const h = level > 0.02 ? 10 + level * 78 * wobble : 6;
    b.style.height = `${h}px`;
    b.style.background = agentTalking ? '#ff5a1f' : callerTalking ? '#fff' : '#8a93b5';
    b.style.opacity = callUi;
  });

  $('#names').style.opacity = callUi;

  const tag = $('#tag');
  tag.style.opacity = (seg ? 1 : 0) * callUi;
  tag.textContent = agentTalking
    ? `${S.agentName.toUpperCase()} · AI`
    : (S.callerName || 'Caller').toUpperCase();
  tag.style.color = agentTalking ? '#ff9a5e' : '#ffffff';

  const capEl = $('#caption');
  const cap = CAPTIONS.find((c) => tc >= c.a && tc <= c.b + 0.35);
  if (cap) capEl.textContent = cap.text;
  show(capEl, (cap ? 1 : 0) * callUi, false);

  const capsEl = $('#caps');
  let capsV = 0;
  for (const c of S.caps) {
    const v = vis(tc, c.at, c.until);
    if (v > 0) {
      capsV = v;
      capsEl.querySelector('.t').textContent = c.title;
      capsEl.querySelector('.s').textContent = c.subtitle || '';
    }
  }
  show(capsEl, capsV * callUi);

  // --- endings ---------------------------------------------------------------

  recapRows.forEach((el, i) => show(el, vis(t, T_RECAP + 0.9 + i * 0.6, T_OUTCOME - 0.5)));
  tileEls.forEach((el, i) => show(el, vis(t, T_OUTCOME + 1.0 + i * 0.35, T_OUTRO - 0.5)));
  show($('#outLine'), vis(t, T_OUTCOME + 0.2, T_OUTRO - 0.5));
  show($('#outroLines'), vis(t, T_OUTRO + 0.3, T_CTA - 0.5));
  show($('#outroGenesys'), vis(t, T_OUTRO + 1.2, T_CTA - 0.5), false);
  show($('#outroPill'), vis(t, T_OUTRO + 1.8, T_CTA - 0.5));
  show($('#ctaPartner'), vis(t, T_CTA + 0.2, TOTAL), false);
  show($('#ctaEyebrow'), vis(t, T_CTA + 0.6, TOTAL));
  show($('#ctaTitle'), vis(t, T_CTA + 0.9, TOTAL));
  show($('#ctaNote'), vis(t, T_CTA + 1.4, TOTAL));
  show($('#ctaPowered'), vis(t, T_CTA + 2.4, TOTAL));
  show($('#ctaGenesys'), vis(t, T_CTA + 2.4, TOTAL), false);

  const phone = $('#phoneTile');
  show(phone, vis(t, T_CTA + 1.9, TOTAL));
  phone.style.borderColor = 'transparent';
};

window.render(0);
