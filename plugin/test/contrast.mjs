/**
 * Button legibility check for the KNX panel.
 *
 * The panel's buttons are styled with Harness theme tokens, and the failure mode
 * here is a token pair that looks plausible but measures unreadable: the primary
 * fill comes from --dsw-alias-button-primary-fill, and pairing it with
 * --dsw-alias-button-contrast-fill gives #f9fafb on #f9fafb in the dark theme —
 * 1.00:1, a label that is simply not there. This check resolves the same var()
 * chains a browser resolves, applies the real cascade for each button state, and
 * asserts a WCAG contrast floor, so the pairing cannot silently regress.
 *
 * `node test/contrast.mjs`
 *
 * Token values are read from the installed Harness theme bundle when it is
 * present; otherwise the frozen snapshot below is used, so CI (which has no
 * Harness install) still exercises the same maths.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const THEME_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  process.env.DSH_THEME_BUNDLE ?? '',
].filter(Boolean);

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
// token values
// ---------------------------------------------------------------------------

/**
 * Frozen snapshot of the alias layer the panel uses, taken from
 * @deepseek-ai/dsh-client-ui-theme (design_platform_css_default). Only the tokens
 * the button rules touch are listed. Tests read live values when the bundle is
 * installed; this snapshot is the offline fallback and the drift reference.
 */
const SNAPSHOT = {
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-layer-3': '#ffffff',
    '--dsw-alias-label-primary': '#0f1115',
    '--dsw-alias-label-secondary': '#61666b',
    '--dsw-alias-label-tertiary': '#81858c',
    '--dsw-alias-label-primary-foreground': '#ffffff',
    '--dsw-alias-label-primary-inverted': '#ffffff',
    '--dsw-alias-button-primary-fill': '#0f1115',
    '--dsw-alias-button-primary-hover': '#43454a',
    '--dsw-alias-button-primary-dimmed': '#ebeef2',
    '--dsw-alias-button-contrast-fill': '#61666b',
    '--dsw-alias-interactive-bg-hover': 'rgba(38, 49, 72, 0.059)',
  },
  dark: {
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-bg-layer-2': '#2c2c2e',
    '--dsw-alias-bg-layer-3': '#353638',
    '--dsw-alias-label-primary': '#f9fafb',
    '--dsw-alias-label-secondary': '#cfd3d6',
    '--dsw-alias-label-tertiary': '#adb2b8',
    '--dsw-alias-label-primary-foreground': '#0f1115',
    '--dsw-alias-label-primary-inverted': '#353638',
    '--dsw-alias-button-primary-fill': '#f9fafb',
    '--dsw-alias-button-primary-hover': '#ebeef2',
    '--dsw-alias-button-primary-dimmed': '#43454a',
    '--dsw-alias-button-contrast-fill': '#f9fafb',
    '--dsw-alias-interactive-bg-hover': 'rgba(255, 255, 255, 0.078)',
  },
};

/** Parse `design_platform_css_default` into light and dark alias layers. */
function liveTokens(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8');
  const hit = source.match(/var design_platform_css_default = ("(?:[^"\\]|\\.)*");/);
  if (!hit) return undefined;
  const css = JSON.parse(hit[1]);
  const blocks = [];
  const re = /(body(?:\[data-ds-dark-theme\])?)\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    const decls = {};
    for (const part of match[2].split(';')) {
      const index = part.indexOf(':');
      if (index < 0) continue;
      decls[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    blocks.push({ selector: match[1], decls });
  }
  const light = Object.assign({}, ...blocks.filter((b) => b.selector === 'body').map((b) => b.decls));
  const dark = { ...light, ...Object.assign({}, ...blocks.filter((b) => b.selector !== 'body').map((b) => b.decls)) };

  const pick = (env) => Object.fromEntries(
    Object.keys(SNAPSHOT.light).map((name) => [name, resolveVar(env, name) ?? '']),
  );
  return { light: pick(light), dark: pick(dark), raw: { light, dark } };
}

function resolveVar(env, name, seen = new Set()) {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const raw = env[name];
  if (raw === undefined) return undefined;
  const only = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (only) return resolveVar(env, only[1], seen);
  return raw;
}

// KNX_CONTRAST_SNAPSHOT=1 forces the frozen snapshot, which is what a CI runner
// without a Harness install gets; use it to check the offline path locally.
const forceSnapshot = process.env.KNX_CONTRAST_SNAPSHOT === '1';
const themeBundle = forceSnapshot ? undefined : THEME_CANDIDATES.find((path) => existsSync(path));
let TOKENS = SNAPSHOT;
let live;
if (themeBundle) {
  const parsed = liveTokens(themeBundle);
  if (parsed) {
    TOKENS = { light: parsed.light, dark: parsed.dark };
    live = parsed;
  }
}
console.log(`button legibility (tokens: ${themeBundle ? 'live Harness bundle' : 'frozen snapshot'})`);

// ---------------------------------------------------------------------------
// colour maths
// ---------------------------------------------------------------------------

function parseColour(value) {
  const text = String(value ?? '').trim();
  const hex = text.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = text.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  return undefined;
}

const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

function luminance({ r, g, b }) {
  const linear = (channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// ---------------------------------------------------------------------------
// the panel stylesheet
// ---------------------------------------------------------------------------

const source = readFileSync(clientPath, 'utf8');
const cssHit = source.match(/const css = `([\s\S]*?)`;/);
if (!cssHit) {
  console.error('FAIL could not find the panel stylesheet in client.js');
  process.exit(1);
}
const panelCss = cssHit[1];

const rules = [];
for (const line of panelCss.split('\n')) {
  const hit = line.match(/^\s*([^{}]+?)\s*\{([^}]*)\}\s*$/);
  if (!hit) continue;
  const selector = hit[1].trim();
  if (!/^\.knx-btn/.test(selector)) continue;
  const decls = {};
  for (const part of hit[2].split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    decls[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  rules.push({ selector, decls });
}

/**
 * Cascade stand-in: each selector the panel can emit is mapped to the element
 * shape it needs plus its specificity, so the winning declaration per property
 * follows the same order a browser would use.
 */
const SELECTORS = {
  '.knx-btn': { classes: ['knx-btn'], state: 'plain', specificity: 10 },
  '.knx-btn.primary': { classes: ['knx-btn', 'primary'], state: 'plain', specificity: 20 },
  '.knx-btn.ghost': { classes: ['knx-btn', 'ghost'], state: 'plain', specificity: 20 },
  '.knx-btn:disabled': { classes: ['knx-btn'], state: 'disabled', specificity: 20 },
  '.knx-btn:hover:not(:disabled)': { classes: ['knx-btn'], state: 'hover', specificity: 30 },
  '.knx-btn.primary:hover:not(:disabled)': { classes: ['knx-btn', 'primary'], state: 'hover', specificity: 40 },
  '.knx-btn.primary:disabled': { classes: ['knx-btn', 'primary'], state: 'disabled', specificity: 30 },
  '.knx-btn.ghost:hover:not(:disabled)': { classes: ['knx-btn', 'ghost'], state: 'hover', specificity: 40 },
  '.knx-btn.ghost:disabled': { classes: ['knx-btn', 'ghost'], state: 'disabled', specificity: 30 },
};

check('every button rule in the panel is covered by this check',
  rules.every((rule) => SELECTORS[rule.selector]),
  rules.filter((rule) => !SELECTORS[rule.selector]).map((rule) => rule.selector).join(', '));

/** A rule in state X applies to an element in state Y; plain rules always apply. */
function applies(ruleState, elementState) {
  if (ruleState === 'plain') return true;
  return ruleState === elementState;
}

/**
 * Resolve the winning declaration set for one element shape. State rules inherit
 * from the plain rules they override, exactly like the cascade: a `:hover` rule
 * that only sets background keeps the base colour.
 */
function styleOf(classes, state) {
  const winning = {};
  rules.forEach((rule) => {
    const shape = SELECTORS[rule.selector];
    if (!shape) return;
    if (!shape.classes.every((name) => classes.includes(name))) return;
    if (!applies(shape.state, state)) return;
    for (const [property, value] of Object.entries(rule.decls)) {
      const current = winning[property];
      // Equal specificity: the later rule in the stylesheet wins.
      if (!current || shape.specificity >= current.specificity) {
        winning[property] = { value, specificity: shape.specificity };
      }
    }
  });
  return Object.fromEntries(Object.entries(winning).map(([k, v]) => [k, v.value]));
}

/** Take the first resolvable var() of a declaration, else its literal. */
function colourOf(env, declaration) {
  if (declaration === undefined) return undefined;
  const vars = [...String(declaration).matchAll(
    /var\(\s*(--[\w-]+)\s*(?:,\s*var\(\s*(--[\w-]+)\s*\))?\s*\)/g,
  )];
  for (const hit of vars) {
    for (const name of [hit[1], hit[2]]) {
      if (!name) continue;
      const value = env[name];
      if (value) return parseColour(value);
    }
  }
  const literal = parseColour(declaration);
  return literal;
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

/** WCAG AA for 13px text is 4.5:1; disabled controls only need to stay legible. */
const FLOOR = { enabled: 4.5, disabled: 3 };
const STATES = [
  ['普通按钮', ['knx-btn'], 'plain'],
  ['普通按钮 hover', ['knx-btn'], 'hover'],
  ['普通按钮 disabled', ['knx-btn'], 'disabled'],
  ['主按钮', ['knx-btn', 'primary'], 'plain'],
  ['主按钮 hover', ['knx-btn', 'primary'], 'hover'],
  ['主按钮 disabled', ['knx-btn', 'primary'], 'disabled'],
  ['幽灵按钮', ['knx-btn', 'ghost'], 'plain'],
  ['幽灵按钮 hover', ['knx-btn', 'ghost'], 'hover'],
  ['幽灵按钮 disabled', ['knx-btn', 'ghost'], 'disabled'],
];

const results = { light: [], dark: [] };
for (const scheme of ['light', 'dark']) {
  const env = TOKENS[scheme];
  const page = colourOf(env, `var(--dsw-alias-bg-base)`);
  // the buttons sit in .knx-card
  const card = colourOf(env, `var(--dsw-alias-bg-layer-1)`) ?? page;
  const rows = [];
  for (const [label, classes, state] of STATES) {
    const style = styleOf(classes, state);
    const bgRaw = colourOf(env, style.background);
    const fgRaw = colourOf(env, style.color);
    const bg = !bgRaw || bgRaw.a < 1 ? (bgRaw ? over(bgRaw, card) : card) : bgRaw;
    const fg = !fgRaw ? undefined : (fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw);
    if (!bg || !fg) {
      console.log(`  FAIL ${scheme}/${label} unresolved (${style.background} / ${style.color})`);
      failures += 1;
      continue;
    }
    const ratio = Number(contrast(fg, bg).toFixed(2));
    rows.push({ label, state, ratio, fg: hex(fg), bg: hex(bg) });
    const floor = FLOOR[state === 'disabled' ? 'disabled' : 'enabled'];
    check(`${scheme} ${label} ${fg ? hex(fg) : '?'} on ${hex(bg)} >= ${floor}:1`, ratio >= floor, `${ratio}:1`);
  }
  results[scheme] = rows;
}

// ---------------------------------------------------------------------------
// the specific pairing that used to fail
// ---------------------------------------------------------------------------

console.log('token pairing');
const primaryStyle = styleOf(['knx-btn', 'primary'], 'plain');
check('primary label uses the foreground token, not the contrast fill',
  /--dsw-alias-label-primary-foreground/.test(primaryStyle.color ?? ''),
  primaryStyle.color);
check('primary label declares an inverted fallback',
  /--dsw-alias-label-primary-inverted/.test(primaryStyle.color ?? ''),
  primaryStyle.color);

// Informational: why the contrast fill must not be used. If upstream ever makes
// these two tokens differ again, re-read this pairing instead of assuming.
for (const scheme of ['light', 'dark']) {
  const fill = colourOf(TOKENS[scheme], `var(--dsw-alias-button-primary-fill)`);
  const contrastFill = colourOf(TOKENS[scheme], `var(--dsw-alias-button-contrast-fill)`);
  if (!fill || !contrastFill) continue;
  const wouldBe = Number(contrast(contrastFill, fill).toFixed(2));
  console.log(`  INFO ${scheme}: fill ${hex(fill)} vs contrast-fill ${hex(contrastFill)} = ${wouldBe}:1` +
    `${wouldBe < 4.5 ? ' (unusable as a label - this is the bug)' : ' (differs upstream now; re-evaluate the pairing)'}`);
}

// Snapshot drift: a warning, not a failure - upstream token values may move while
// the semantic pairing stays correct.
if (live) {
  const drift = [];
  for (const scheme of ['light', 'dark']) {
    for (const [name, snapshot] of Object.entries(SNAPSHOT[scheme])) {
      const current = TOKENS[scheme][name];
      if (current && parseColour(current) && parseColour(snapshot)
        && hex(parseColour(current)) !== hex(parseColour(snapshot))) {
        drift.push(`${scheme} ${name}: ${snapshot} -> ${current}`);
      }
    }
  }
  console.log(drift.length
    ? `  INFO snapshot drift (live values were used): ${drift.join('; ')}`
    : '  INFO snapshot matches the installed theme');
}

console.log('');
for (const scheme of ['light', 'dark']) {
  console.log(`${scheme}: ` + results[scheme]
    .map((row) => `${row.label} ${row.ratio}:1`)
    .join(' | '));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nbutton legibility verified');
process.exit(failures ? 1 : 0);
