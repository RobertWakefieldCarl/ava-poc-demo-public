# Branding capture

How `capture-customer-page.mjs` works, and what to do when it gets something wrong.

## What the script does

```bash
node "<SkillDir>/scripts/capture-customer-page.mjs" --url <https://site> --out-dir <dir>
```

1. Loads the page at 1440×900, 2× device scale, and waits for the load event.
2. Dismisses cookie and consent banners (button text in English, Spanish and French), then removes
   anything still `position: fixed` whose id or class looks like a consent shell.
3. **Removes the site's own live-chat launcher** — see below.
4. Scrolls the full height to trigger lazy-loaded images, then returns to the top, and sweeps for
   chat launchers a second time because many only mount after the visitor scrolls.
5. Picks a brand color — see below.
6. Picks a logo, scoring candidates on "logo"/"brand"/"wordmark" in their alt, class, id or src,
   whether they sit in a header or nav, their size, and their distance from the top. Inline header
   SVGs are preferred. Falls back to the favicon, then `og:image`, then a crop of the logo's box.
7. Measures the saved logo's mean luminance and sets `logoBackground` to a dark chip for light
   artwork and white for dark artwork, so the widget badge always has contrast.
8. Writes `page.jpg` (full page by default), the logo, and `brand.json`.

### Removing the customer's own chat widget

The demo composites a mock AVA widget onto this page. If the customer already runs a chat vendor and
its launcher survives into the backdrop, the finished demo shows **two chat widgets at once** — which
is the first thing the customer notices and the hardest thing to explain away.

The script removes them in two passes: named vendor elements and iframes (Intercom, Drift, Zendesk,
HubSpot, Podium, LivePerson, Tawk, Crisp, Freshchat, Olark, Tidio, Kustomer, Gorgias and similar),
then any unnamed small fixed-position box pinned to a bottom corner with a high stacking order.

It prints what it removed. If it reports `none found` on a site you know runs a launcher, open
`page.jpg` before continuing and, if it's there, crop it out or supply your own screenshot. Pass
`--keep-chat-widgets` only when you deliberately want the customer's current widget visible.

### Brand color

Two methods, in order:

1. **Sampled from the rendered header band** — the top ~10% of the captured image is quantized and
   the dominant saturated color wins, provided it covers at least 12% of the band. This is the
   reliable method: themes frequently paint the navigation bar on a wrapper no CSS traversal
   reaches, and plenty of headers compute to fully transparent while clearly looking colored.
2. **Derived from CSS** — used when the band is white, grey or near-black, where there is no brand
   color in the pixels to find. Takes the most saturated candidate among `meta[theme-color]`, header
   and nav button backgrounds, link color, and header background.

The script says which one it used. Both are best-effort; the customer's brand guide always wins.

### Image size

`generate-demo.mjs` inlines the backdrop into `demo.html` as a base64 data URI, which costs about a
third again in size. A full-page PNG of a modern marketing site is several megabytes and produces a
demo nobody can email, so the capture defaults to JPEG at quality 82 and clips anything taller than
4200px — the lower reaches of a long page sit behind the widget and are never seen anyway.

### Options

| Flag | Effect |
|------|--------|
| `--width`, `--height` | Viewport size (default 1440×900) |
| `--viewport-only` | Capture just the visible fold instead of the whole page |
| `--wait <ms>` | Settle time before capture — raise for heavy animation (default 1500) |
| `--timeout <ms>` | Navigation timeout (default 45000) |
| `--no-dismiss-banners` | Skip banner dismissal when it removes real page content |
| `--keep-chat-widgets` | Leave the site's own live-chat launcher in the screenshot |
| `--format <jpeg\|png>` | Screenshot format (default jpeg) |
| `--quality <1-100>` | JPEG quality (default 82) |
| `--max-height <px>` | Clip a very long capture (default 4200; `0` disables) |

## Overriding the results

Everything the capture produces is advisory. `recording.json` → `customer` wins:

```json
"customer": {
  "name": "Acme Dental",
  "siteUrl": "https://www.acmedental.com",
  "pageImage": "assets/page.jpg",
  "logoFile": "assets/logo.svg",
  "logoBackground": "#ffffff",
  "brandColor": "#0b5c8a",
  "brandColorDark": "#073f5e"
}
```

- `brandColor` drives the widget header, customer bubbles, send button and all accents.
  `brandColorDark` is used for tool-call chip text; set it 25–30% darker.
- `logoBackground` is the badge behind the logo. Set it to `#ffffff` for a normal dark logo, or a
  dark hex for a white or light logo.
- Any `pageImage` or `logoFile` works — a hand-taken screenshot, an asset the customer supplied, or
  a file from the AXL session folder. Paths resolve relative to `recording.json`.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `Playwright could not be resolved` | `npm install -g playwright && npx playwright install chromium`. The script also finds Playwright nested inside a global `@playwright/cli`. |
| Logo not found | The site uses a CSS background-image logo. Save the logo manually into `assets/` and set `customer.logoFile`. |
| Logo invisible in the widget | The luminance check misjudged a two-tone logo. Set `customer.logoBackground` explicitly. |
| Brand color is grey or near-black | The site has no saturated accent. Set `customer.brandColor` by hand from the customer's brand guide. |
| Brand color came from the hero photo | The header band was too transparent to sample and CSS found an image-derived accent. Set `customer.brandColor` by hand. |
| Cookie banner still in the screenshot | Re-run with a larger `--wait`, or dismiss it manually in a real browser and supply your own screenshot. |
| The customer's own chat bubble is in the backdrop | The vendor was unrecognised. Crop it out, or supply your own screenshot and set `customer.pageImage`. |
| Screenshot is enormous | Lower `--quality` to 70, lower `--max-height` to 3000, use `--viewport-only`, or pass `--no-embed` to `generate-demo.mjs` so the image is linked rather than inlined. |
| Page renders half-empty | A heavy SPA that was still hydrating. Raise `--wait` to 4000–6000. |
| Navigation times out | The site blocks headless traffic. Capture manually and set `customer.pageImage`. |

## Demo page layout notes

The widget is fixed at 390px wide, bottom-right of the page viewport, which is capped at 76% of the
window height. If the widget covers something important in the screenshot, the simplest fixes are to
capture with a wider `--width` so the page content spreads out, or to use `--viewport-only` and pick
a section of the site with clear space on the right.
