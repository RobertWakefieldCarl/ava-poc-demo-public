#!/usr/bin/env node
'use strict';

/**
 * Capture a customer's public web page as demo backdrop material.
 *
 * Writes into --out-dir:
 *   page.(jpg|png)  full-page screenshot, web-sized so it stays emailable once inlined
 *   logo.(svg|png)  best-effort brand logo
 *   brand.json      { siteUrl, title, logoFile, pageImage, brandColor, brandColorDark, accentColor }
 *
 * Usage:
 *   node capture-customer-page.mjs --url https://example.com --out-dir <dir>
 *     [--width 1440] [--height 900] [--viewport-only] [--timeout 45000]
 *     [--wait 1500] [--no-dismiss-banners] [--keep-chat-widgets]
 *     [--format jpeg|png] [--quality 82] [--max-height 4200]
 *
 * generate-demo.mjs inlines this screenshot into demo.html as a base64 data URI, which
 * inflates it by ~33%. A full-page PNG of a modern marketing site runs to several
 * megabytes and produces a demo nobody can email, so JPEG is the default here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';

function parseArgs(argv) {
  const out = {
    url: null,
    outDir: null,
    width: 1440,
    height: 900,
    fullPage: true,
    timeout: 45000,
    wait: 1500,
    dismissBanners: true,
    hideChatWidgets: true,
    format: 'jpeg',
    quality: 82,
    maxHeight: 4200,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--out-dir') out.outDir = path.resolve(argv[++i]);
    else if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
    else if (a === '--viewport-only') out.fullPage = false;
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--wait') out.wait = Number(argv[++i]);
    else if (a === '--no-dismiss-banners') out.dismissBanners = false;
    else if (a === '--keep-chat-widgets') out.hideChatWidgets = false;
    else if (a === '--format') out.format = String(argv[++i]).toLowerCase() === 'png' ? 'png' : 'jpeg';
    else if (a === '--quality') out.quality = Number(argv[++i]);
    else if (a === '--max-height') out.maxHeight = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `Usage:
  node capture-customer-page.mjs --url <https://site> --out-dir <dir>

Options:
  --width <px>           Viewport width (default 1440)
  --height <px>          Viewport height (default 900)
  --viewport-only        Capture only the visible fold instead of the full page
  --timeout <ms>         Navigation timeout (default 45000)
  --wait <ms>            Settle time after load before capture (default 1500)
  --no-dismiss-banners   Skip the cookie/consent dismissal pass
  --keep-chat-widgets    Leave the site's own live-chat launcher in the screenshot
  --format <jpeg|png>    Screenshot format (default jpeg — keeps demo.html emailable)
  --quality <1-100>      JPEG quality (default 82; ignored for png)
  --max-height <px>      Trim a very long full-page capture (default 4200, 0 disables)
`;



const BANNER_PATTERNS = [
  /^(accept|accept all|accept all cookies|allow all|i agree|agree|got it|ok|understood)$/i,
  /^(aceptar|aceptar todo|de acuerdo|entendido)$/i,
  /^(tout accepter|j'accepte|accepter)$/i,
];

async function dismissBanners(page) {
  for (const pattern of BANNER_PATTERNS) {
    try {
      const button = page.getByRole('button', { name: pattern }).first();
      if (await button.isVisible({ timeout: 1200 })) {
        await button.click({ timeout: 1500 });
        await page.waitForTimeout(600);
      }
    } catch {
      /* no banner matched this pattern */
    }
  }
  // Collapse anything still pinned over the page (consent shells, sticky promos).
  await page.evaluate(() => {
    const kill = /cookie|consent|gdpr|onetrust|truste|privacy-banner|cky-/i;
    for (const el of Array.from(document.querySelectorAll('div,section,aside,dialog'))) {
      const id = `${el.id} ${el.className}`;
      if (typeof id !== 'string' || !kill.test(id)) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky' || el.tagName === 'DIALOG') el.remove();
    }
  });
}

/**
 * Remove the site's own live-chat launcher before the screenshot.
 *
 * The demo composites a mock AVA widget onto this page. If the customer already runs
 * a chat vendor, the captured page keeps that launcher and the finished demo shows two
 * chat widgets at once — which the customer notices immediately.
 */
async function hideChatWidgets(page) {
  return page.evaluate(() => {
    const VENDOR =
      /intercom|drift|zendesk|zopim|livechat|liveperson|tawk|crisp|freshchat|freshworks|hubspot|podium|olark|tidio|birdeye|genesys-?(chat|messenger)|salesforce-?chat|embeddedservice|gorgias|kustomer|ada-?(chat|embed)|chat-?(widget|launcher|bubble|button)|messenger-?(widget|launcher)|webchat/i;

    const removed = [];
    const consider = (el, how) => {
      if (!el || !el.isConnected) return;
      const hay = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${
        el.getAttribute?.('title') || ''
      } ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('src') || ''}`;
      if (!VENDOR.test(hay)) return;
      removed.push(`${how}:${(el.id || el.className || el.tagName).toString().slice(0, 40)}`);
      el.remove();
    };

    // Vendors mount either a named iframe or a fixed-position host element.
    for (const el of Array.from(document.querySelectorAll('iframe'))) consider(el, 'iframe');
    for (const el of Array.from(document.querySelectorAll('div,aside,section,button'))) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') consider(el, 'fixed');
    }

    // Catch unnamed launchers: a small fixed box pinned to a bottom corner with a high
    // stacking order is a chat bubble often enough, and nothing else belongs there in a
    // backdrop screenshot anyway.
    for (const el of Array.from(document.querySelectorAll('div,aside,button'))) {
      if (!el.isConnected) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      if (Number(cs.zIndex) < 1000) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.width > 460 || r.height > 620) continue;
      const nearBottom = r.bottom > window.innerHeight - 180;
      const nearSide = r.left < 180 || r.right > window.innerWidth - 180;
      if (!nearBottom || !nearSide) continue;
      removed.push(`corner:${Math.round(r.width)}x${Math.round(r.height)}`);
      el.remove();
    }
    return removed;
  });
}

/** Rank logo candidates in the page and return a descriptor for the best one. */
async function findLogo(page) {
  return page.evaluate(() => {
    const score = (el) => {
      const hay = [
        el.getAttribute('alt') || '',
        el.getAttribute('class') || '',
        el.getAttribute('id') || '',
        el.getAttribute('src') || '',
        el.getAttribute('data-testid') || '',
      ]
        .join(' ')
        .toLowerCase();
      let s = 0;
      if (/logo|brand|wordmark/.test(hay)) s += 40;
      if (el.closest('header,nav,[role="banner"]')) s += 25;
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 14 && rect.width < 500 && rect.height < 160) s += 20;
      if (rect.top < 220) s += 15;
      if (/icon|avatar|sprite|placeholder/.test(hay)) s -= 25;
      if (rect.width === 0 || rect.height === 0) s -= 100;
      return s;
    };

    const toRect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };

    let best = null;
    for (const el of Array.from(document.querySelectorAll('header img, nav img, [role="banner"] img, img'))) {
      const s = score(el);
      if (s > 0 && (!best || s > best.score)) {
        best = { score: s, kind: 'img', src: el.currentSrc || el.src, rect: toRect(el) };
      }
    }
    for (const el of Array.from(document.querySelectorAll('header svg, nav svg, [role="banner"] svg'))) {
      const s = score(el) + 10; // inline SVG logos are usually the real wordmark
      if (s > 0 && (!best || s > best.score)) {
        const r = toRect(el);
        best = { score: s, kind: 'svg', markup: el.outerHTML, rect: r };
      }
    }
    if (!best) {
      const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
      const og = document.querySelector('meta[property="og:image"]');
      if (icon) best = { score: 1, kind: 'img', src: new URL(icon.getAttribute('href'), location.href).href };
      else if (og) best = { score: 1, kind: 'img', src: new URL(og.getAttribute('content'), location.href).href };
    }
    return best;
  });
}

async function saveLogo(page, logo, outDir) {
  if (!logo) return null;

  if (logo.kind === 'svg' && logo.markup) {
    const markup = logo.markup.includes('xmlns')
      ? logo.markup
      : logo.markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    fs.writeFileSync(path.join(outDir, 'logo.svg'), markup, 'utf8');
    return 'logo.svg';
  }

  if (logo.kind === 'img' && logo.src) {
    if (logo.src.startsWith('data:')) {
      const m = logo.src.match(/^data:([^;,]+)(;base64)?,(.*)$/);
      if (m) {
        const ext = m[1].includes('svg') ? 'svg' : m[1].split('/')[1] || 'png';
        const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
        fs.writeFileSync(path.join(outDir, `logo.${ext}`), buf);
        return `logo.${ext}`;
      }
    } else {
      try {
        const res = await page.request.get(logo.src, { timeout: 15000 });
        if (res.ok()) {
          const ctype = (res.headers()['content-type'] || '').toLowerCase();
          const ext = ctype.includes('svg')
            ? 'svg'
            : ctype.includes('png')
              ? 'png'
              : ctype.includes('webp')
                ? 'webp'
                : ctype.includes('jpeg') || ctype.includes('jpg')
                  ? 'jpg'
                  : path.extname(new URL(logo.src).pathname).replace('.', '') || 'png';
          fs.writeFileSync(path.join(outDir, `logo.${ext}`), await res.body());
          return `logo.${ext}`;
        }
      } catch {
        /* fall through to the element screenshot */
      }
    }
  }

  // Last resort: crop the logo's bounding box out of the rendered page.
  if (logo.rect && logo.rect.width > 0) {
    try {
      await page.screenshot({
        path: path.join(outDir, 'logo.png'),
        clip: {
          x: Math.max(0, logo.rect.x),
          y: Math.max(0, logo.rect.y),
          width: logo.rect.width,
          height: logo.rect.height,
        },
      });
      return 'logo.png';
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Dominant colour of the captured page's top band, read from the pixels.
 *
 * Reading the brand colour out of CSS fails on a large share of real sites: themes
 * routinely paint the navigation bar on a wrapper the traversal doesn't reach, or the
 * whole header subtree computes to rgba(0,0,0,0) and the colour comes from somewhere
 * else entirely. The rendered screenshot has no such ambiguity — whatever is behind the
 * navigation is simply there. Falls back to null when the band is plain white or grey,
 * which is the case where the CSS-derived accent is the better answer.
 */
async function sampleHeaderColor(context, outDir, pageImage) {
  const page = await context.newPage();
  try {
    await page.goto(`${pathToFileURL(outDir).href}/`);
    return await page.evaluate(async (name) => {
      const img = new Image();
      img.src = name;
      try {
        await img.decode();
      } catch {
        return null;
      }
      const w = Math.min(1200, img.naturalWidth || 0);
      // The navigation bar lives in roughly the first 10% of a full-page capture; cap it
      // so a tall page doesn't drag the hero image into the sample.
      const h = Math.max(8, Math.min(160, Math.round((img.naturalHeight || 0) * 0.1)));
      if (!w || !h) return null;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);

      let data;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch {
        return null;
      }

      // Quantise to 5 bits per channel so anti-aliasing and JPEG noise collapse together.
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      let best = null;
      for (const [key, n] of counts) {
        const r = ((key >> 10) & 31) * 8;
        const g = ((key >> 5) & 31) * 8;
        const b = (key & 31) * 8;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max === 0) continue;
        const sat = (max - min) / max;
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        // Skip white, near-black and unsaturated greys — none of them is a brand colour.
        if (sat < 0.18 || lum > 0.93 || lum < 0.06) continue;
        if (!best || n > best.n) best = { n, r, g, b };
      }
      if (!best) return null;
      // Require the winner to actually dominate the band rather than being a stray accent.
      const total = w * h;
      if (best.n / total < 0.12) return null;
      const hex = (v) => v.toString(16).padStart(2, '0');
      return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
    }, pageImage);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Mean luminance of the saved logo's opaque pixels (0 = black art, 1 = white art).
 * Decides whether the widget's logo badge needs a dark or a light background: a white
 * wordmark lifted from a dark site header is invisible on a white badge.
 */
async function measureLogoLuminance(context, outDir, logoFile) {
  if (!logoFile) return null;
  const page = await context.newPage();
  try {
    await page.goto(`${pathToFileURL(outDir).href}/`);
    return await page.evaluate(async (name) => {
      const img = new Image();
      img.src = name;
      try {
        await img.decode();
      } catch {
        return null;
      }
      const w = Math.max(1, Math.min(240, img.naturalWidth || 240));
      const h = Math.max(1, Math.min(240, img.naturalHeight || 80));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const data = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 24) continue; // ignore transparent padding
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          n += 1;
        }
        return n ? sum / n : null;
      } catch {
        return null; // canvas tainted
      }
    }, logoFile);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

function rgbToHex(value) {
  if (!value) return null;
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
  if (!m) return /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
  if (m[4] !== undefined && Number(m[4]) < 0.25) return null;
  const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

function saturation(hex) {
  if (!hex || hex.length < 7) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function luminance(hex) {
  if (!hex || hex.length < 7) return 1;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function darken(hex, amount = 0.25) {
  if (!hex || hex.length < 7) return hex;
  const parts = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.max(0, Math.round(v * (1 - amount)))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

async function extractBrandColors(page) {
  const raw = await page.evaluate(() => {
    const pick = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const candidates = [];
    const buttons = Array.from(
      document.querySelectorAll('header a[class*="btn"], header button, nav a[class*="btn"], a[class*="cta"], button[class*="primary"], .btn-primary')
    ).slice(0, 12);
    for (const b of buttons) {
      const cs = getComputedStyle(b);
      candidates.push(cs.backgroundColor);
      candidates.push(cs.borderColor);
    }
    // A <header> is frequently transparent, with the coloured bar on a child element.
    // Walk the header subtree and collect painted backgrounds, widest band first, so a
    // real navigation bar outranks a swatch sampled from the hero photograph.
    const headerBands = [];
    const headerRoot = document.querySelector('header, [role="banner"], nav');
    if (headerRoot) {
      const nodes = [headerRoot, ...Array.from(headerRoot.querySelectorAll('*')).slice(0, 120)];
      for (const el of nodes) {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (!bg || bg === 'transparent' || /rgba\(.*,\s*0\s*\)$/.test(bg)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 240 || r.height < 24 || r.top > 260) continue;
        headerBands.push({ color: bg, area: r.width * r.height });
      }
      headerBands.sort((a, b) => b.area - a.area);
    }

    return {
      headerBg: pick('header', 'backgroundColor') || pick('nav', 'backgroundColor'),
      headerBands: headerBands.slice(0, 6).map((b) => b.color),
      linkColor: pick('main a, article a, a', 'color'),
      candidates,
      title: document.title,
      themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
    };
  });

  const pool = [raw.themeColor, ...raw.candidates, raw.linkColor, raw.headerBg]
    .map(rgbToHex)
    .filter((hex) => hex && hex.length === 7);

  // The brand colour is the most saturated non-washed-out candidate.
  const accent =
    pool
      .filter((hex) => saturation(hex) > 0.25 && luminance(hex) < 0.85)
      .sort((a, b) => saturation(b) - saturation(a))[0] || '#1a56a8';

  // Prefer a coloured navigation band over anything else: it is the one surface that is
  // reliably the brand colour rather than imagery or a third-party embed.
  const bandHex = [...(raw.headerBands || []), raw.headerBg]
    .map(rgbToHex)
    .find((hex) => hex && hex.length === 7 && saturation(hex) > 0.2 && luminance(hex) < 0.92);
  const brand = bandHex || accent;

  return {
    title: raw.title,
    brandColor: brand,
    brandColorDark: darken(brand, 0.3),
    accentColor: accent,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.url || !args.outDir) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const { chromium } = await loadPlaywright({
    toolName: 'capture-customer-page',
    hint:
      'Or screenshot the customer site by hand and point recording.json ->' +
      ' customer.pageImage at the image instead.',
  });
  fs.mkdirSync(args.outDir, { recursive: true });

  // --allow-file-access-from-files lets the logo-luminance pass read back a file:// canvas.
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(args.url, { waitUntil: 'load', timeout: args.timeout });
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      /* networkidle never settles on sites with polling; the load event is enough */
    }
    if (args.dismissBanners) await dismissBanners(page);
    const hiddenWidgets = args.hideChatWidgets ? await hideChatWidgets(page) : [];
    await page.waitForTimeout(args.wait);

    // Trigger lazy-loaded imagery, then return to the top for the capture.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    const brand = await extractBrandColors(page);
    const logo = await findLogo(page);
    const logoFile = await saveLogo(page, logo, args.outDir);

    // Re-run the sweep after the lazy-load scroll: some launchers only mount once the
    // visitor has scrolled, so a single early pass misses them.
    if (args.hideChatWidgets) hiddenWidgets.push(...(await hideChatWidgets(page)));

    const pageImage = `page.${args.format === 'png' ? 'png' : 'jpg'}`;
    const shot = { path: path.join(args.outDir, pageImage), fullPage: args.fullPage };
    if (args.format === 'jpeg') {
      shot.type = 'jpeg';
      shot.quality = Math.min(100, Math.max(1, args.quality));
    }
    // A very tall page produces a backdrop whose lower half is never visible behind the
    // widget but still costs megabytes once inlined. Clip it instead.
    if (args.fullPage && args.maxHeight > 0) {
      const fullHeight = await page.evaluate(() => document.body.scrollHeight);
      if (fullHeight > args.maxHeight) {
        delete shot.fullPage;
        shot.clip = { x: 0, y: 0, width: args.width, height: args.maxHeight };
      }
    }
    await page.screenshot(shot);
    const shotKB = Math.round(fs.statSync(shot.path).size / 1024);

    // Pixels beat CSS for the brand colour; keep the CSS result as the fallback.
    const sampled = await sampleHeaderColor(context, args.outDir, pageImage);
    if (sampled) {
      brand.brandColor = sampled;
      brand.brandColorDark = darken(sampled, 0.3);
    }

    const logoLum = await measureLogoLuminance(context, args.outDir, logoFile);
    const logoBackground = logoLum !== null && logoLum > 0.6 ? '#1b2430' : '#ffffff';

    const manifest = {
      siteUrl: args.url,
      capturedAt: new Date().toISOString(),
      title: brand.title,
      pageImage,
      logoFile,
      logoBackground,
      brandColor: brand.brandColor,
      brandColorDark: brand.brandColorDark,
      accentColor: brand.accentColor,
      viewport: { width: args.width, height: args.height, fullPage: args.fullPage },
    };
    fs.writeFileSync(path.join(args.outDir, 'brand.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`Captured ${args.url}`);
    console.log(
      `  ${pageImage.padEnd(11)} ${args.fullPage ? 'full page' : 'viewport'} @ ${args.width}x${args.height}` +
        ` · ${shotKB} KB${shot.clip ? ` · clipped to ${args.maxHeight}px` : ''}`
    );
    if (shotKB > 1200) {
      console.log(
        '  note        backdrop is large; demo.html inlines it at ~1.33x. Re-run with' +
          ' --quality 70 or --max-height 3000 if the demo needs to be emailed.'
      );
    }
    console.log(
      `  chat widget ${
        hiddenWidgets.length ? `removed ${hiddenWidgets.length} (${hiddenWidgets.slice(0, 3).join(', ')})` : 'none found'
      }`
    );
    console.log(
      `  logo        ${logoFile || 'NOT FOUND — set customer.logoFile manually'}` +
        (logoLum !== null ? ` (${logoLum > 0.6 ? 'light art → dark badge' : 'dark art → white badge'})` : '')
    );
    console.log(`  brandColor  ${manifest.brandColor} (${sampled ? 'sampled from the header band' : 'from CSS'})`);
    console.log(`  brand.json  ${path.join(args.outDir, 'brand.json')}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`Capture failed: ${err.message}`);
  process.exit(1);
});
