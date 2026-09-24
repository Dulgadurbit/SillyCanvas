/**
 * Silly Canvas: themes.
 *
 * A theme is a set of colours for named roles. Surfaces (panel, blocks, text)
 * and meanings (flow, append, Generate, Decider...) are separate roles, and
 * each meaning keeps one colour everywhere it appears, so changing "Generate"
 * changes Generate blocks, ties and the answers in the chat together.
 *
 * A theme only sets CSS variables on the page. style.css reads them.
 *
 * Your own colours are stored as changes on top of a preset, so a preset can
 * always be got back, and a shared theme is a short piece of JSON.
 */

import { settings, save, safe } from './state.js?v=0.12.0';

/** The roles, in the order the editor lists them. */
export const ROLES = [
    { key: 'panel', label: 'Panel background', group: 'surface' },
    { key: 'block', label: 'Block background', group: 'surface' },
    { key: 'canvas', label: 'Canvas background', group: 'surface' },
    { key: 'border', label: 'Borders', group: 'surface' },
    { key: 'text', label: 'Text', group: 'surface' },
    { key: 'muted', label: 'Quiet text and fallback paths', group: 'surface' },
    { key: 'flow', label: 'Flow, Output and selection', group: 'meaning' },
    { key: 'append', label: 'Append, and blocks that went in', group: 'meaning' },
    { key: 'prepend', label: 'Prepend', group: 'meaning' },
    { key: 'generate', label: 'Generate blocks, ties and answers', group: 'meaning' },
    { key: 'decider', label: 'Decider blocks and keys', group: 'meaning' },
    { key: 'warn', label: 'Warnings and skipped blocks', group: 'meaning' },
    { key: 'error', label: 'Errors and switched-off blocks', group: 'meaning' },
];
const MEANING = ROLES.filter(r => r.group === 'meaning').map(r => r.key);

/**
 * The look of a theme, apart from its colours. Each is a small choice, set on
 * the page as data attributes and CSS variables that style.css reads.
 */
export const STYLE_OPTIONS = {
    shape: { label: 'Shape', options: [['sharp', 'Sharp corners'], ['rounded', 'Rounded'], ['soft', 'Soft and round']] },
    font: { label: 'Font', options: [['theme', 'SillyTavern’s'], ['sans', 'Clean sans'], ['round', 'Friendly rounded'], ['serif', 'Book serif'], ['mono', 'Typewriter mono']] },
    grid: { label: 'Canvas', options: [['dots', 'Dots'], ['lines', 'Grid lines'], ['paper', 'Paper'], ['scan', 'Scanlines'], ['none', 'Plain']] },
    wires: { label: 'Wires', options: [['curved', 'Curved'], ['angled', 'Right angles']] },
    weight: { label: 'Lines', options: [['thin', 'Thin'], ['normal', 'Normal'], ['bold', 'Bold']] },
    header: { label: 'Block headers', options: [['tint', 'Quiet'], ['strip', 'Coloured by type']] },
    depth: { label: 'Depth', options: [['flat', 'Flat'], ['soft', 'Soft shadow'], ['deep', 'Deep shadow'], ['glow', 'Glow']] },
};
const DEFAULT_STYLE = { shape: 'rounded', font: 'theme', grid: 'dots', wires: 'curved', weight: 'normal', header: 'tint', depth: 'soft' };

const FONTS = {
    sans: `system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
    round: `Nunito, Quicksand, 'Varela Round', 'Segoe UI', system-ui, sans-serif`,
    serif: `'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif`,
    mono: `'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', ui-monospace, monospace`,
};
const RADII = { sharp: [2, 1, 3], rounded: [8, 5, 10], soft: [16, 10, 999] };
const WEIGHTS = { thin: [1, 1.6], normal: [1, 2.5], bold: [2, 3.5] };

/**
 * Built-in themes. "SillyTavern" leaves the surfaces to your SillyTavern
 * theme; the others set everything, and each has a look of its own.
 */
export const PRESETS = {
    sillytavern: {
        name: 'SillyTavern',
        note: 'Follows your SillyTavern theme for backgrounds, text and font.',
        style: { ...DEFAULT_STYLE },
        colors: {
            muted: '#9aa0a6',
            flow: '#7ab7ff', append: '#7fd18c', prepend: '#5fd4c8', generate: '#d48fe0',
            decider: '#ff8c42', warn: '#f0c36a', error: '#e08f8f',
        },
    },
    midnight: {
        name: 'Midnight',
        note: 'Clean modern dark. Deep shadows, a dot grid, clear bright signals.',
        style: { shape: 'rounded', font: 'sans', grid: 'dots', wires: 'curved', weight: 'normal', header: 'tint', depth: 'deep' },
        colors: {
            panel: '#0d1015', block: '#171c24', canvas: '#0a0d11', border: '#2a313c', text: '#dfe4ea', muted: '#8b949e',
            flow: '#58a6ff', append: '#3fb950', prepend: '#39c5cf', generate: '#bc8cff',
            decider: '#f0883e', warn: '#e3c341', error: '#f85149',
        },
    },
    blueprint: {
        name: 'Blueprint',
        note: 'Drafting paper: a blue grid, sharp outlines, typewriter labels and right-angled wires.',
        style: { shape: 'sharp', font: 'mono', grid: 'lines', wires: 'angled', weight: 'thin', header: 'tint', depth: 'flat' },
        colors: {
            panel: '#0b2747', block: '#0f3561', canvas: '#12406f', border: '#8fb8e8', text: '#eef5ff', muted: '#a3c1e6',
            flow: '#7fdbff', append: '#a6f29c', prepend: '#5ef0d8', generate: '#ffb3ef',
            decider: '#ffc44d', warn: '#fff38a', error: '#ff8f8f',
        },
    },
    parchment: {
        name: 'Parchment',
        note: 'A light storybook page: cream paper, ink-brown lines, a book serif and coloured chapter headers.',
        style: { shape: 'rounded', font: 'serif', grid: 'paper', wires: 'curved', weight: 'normal', header: 'strip', depth: 'soft' },
        colors: {
            panel: '#efe3c8', block: '#fbf5e4', canvas: '#f3e8cf', border: '#b99c6f', text: '#3a2918', muted: '#7d6547',
            flow: '#2f5d8a', append: '#4d7a2e', prepend: '#2c7a70', generate: '#7a3b8a',
            decider: '#a4521c', warn: '#8a6a00', error: '#a8322a',
        },
    },
    neon: {
        name: 'Neon',
        note: 'Black and violet with glowing wires and edges, bold lines and coloured headers.',
        style: { shape: 'soft', font: 'sans', grid: 'lines', wires: 'curved', weight: 'bold', header: 'strip', depth: 'glow' },
        colors: {
            panel: '#0a0612', block: '#140c24', canvas: '#07040d', border: '#3d2670', text: '#f4ecff', muted: '#a592cc',
            flow: '#00e5ff', append: '#39ff88', prepend: '#b9ff3d', generate: '#ff4dff',
            decider: '#ffae00', warn: '#fff04d', error: '#ff3d6e',
        },
    },
    terminal: {
        name: 'Terminal',
        note: 'Green phosphor on black: typewriter text, square boxes, scanlines and right-angled wires.',
        style: { shape: 'sharp', font: 'mono', grid: 'scan', wires: 'angled', weight: 'normal', header: 'tint', depth: 'flat' },
        colors: {
            panel: '#040804', block: '#091109', canvas: '#030603', border: '#1f6a2c', text: '#8dff9c', muted: '#4fa35c',
            flow: '#3dff6b', append: '#d4ff3d', prepend: '#3dffe0', generate: '#ff7ae5',
            decider: '#ffb000', warn: '#fff23d', error: '#ff4d4d',
        },
    },
    petal: {
        name: 'Petal',
        note: 'Soft and light: rosy paper, round shapes, a friendly font and coloured headers.',
        style: { shape: 'soft', font: 'round', grid: 'dots', wires: 'curved', weight: 'normal', header: 'strip', depth: 'soft' },
        colors: {
            panel: '#fff4f8', block: '#ffffff', canvas: '#ffeaf2', border: '#efb9cc', text: '#3d2230', muted: '#8e6477',
            flow: '#2563eb', append: '#15803d', prepend: '#0e7490', generate: '#a21caf',
            decider: '#c2410c', warn: '#a16207', error: '#be123c',
        },
    },
};

/** Themes that were renamed, so a saved choice still finds its successor. */
const RENAMED = { 'dark-night': 'midnight', 'blue-moon': 'blueprint', 'purple-prose': 'neon', 'pink-blink': 'petal', 'brown-gown': 'parchment' };

export const DEFAULT_PRESET = 'sillytavern';

/* ------------------------------------------------------------------ */
/* colour maths                                                        */
/* ------------------------------------------------------------------ */

export function parseColor(c) {
    const s = String(c ?? '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) {
        const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    return null;
}

export const toHex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** Put a see-through colour over the colour behind it. */
function over(top, under) {
    const a = top.a ?? 1;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

function luminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Perceptual distance between two colours (CIE76 in Lab). Below ~15 they are hard to tell apart. */
export function distance(a, b) {
    const lab = ({ r, g, b }) => {
        const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const R = f(r), G = f(g), B = f(b);
        const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
        const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
        const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
        const t = (v) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
        return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
    };
    const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Darken or lighten a colour, keeping its hue, until it reads against a background. */
export function fitContrast(color, bg, target = 3) {
    if (contrast(color, bg) >= target) return color;
    const darker = luminance(bg) > 0.4;
    let c = { ...color };
    for (let i = 0; i < 24 && contrast(c, bg) < target; i++) {
        c = darker
            ? { r: c.r * 0.9, g: c.g * 0.9, b: c.b * 0.9 }
            : { r: c.r + (255 - c.r) * 0.12, g: c.g + (255 - c.g) * 0.12, b: c.b + (255 - c.b) * 0.12 };
    }
    return c;
}

/* ------------------------------------------------------------------ */
/* the current theme                                                   */
/* ------------------------------------------------------------------ */

function store() {
    const ui = (settings().ui ??= {});
    ui.theme ??= { preset: DEFAULT_PRESET, colors: {}, style: {} };
    ui.theme.colors ??= {};
    ui.theme.style ??= {};
    if (RENAMED[ui.theme.preset]) ui.theme.preset = RENAMED[ui.theme.preset];
    if (!PRESETS[ui.theme.preset]) ui.theme.preset = DEFAULT_PRESET;
    return ui.theme;
}

/** The chosen preset plus your own changes. */
export function currentTheme() {
    const t = store();
    const p = PRESETS[t.preset];
    return {
        preset: t.preset,
        colors: { ...p.colors, ...t.colors },
        custom: { ...t.colors },
        style: { ...DEFAULT_STYLE, ...p.style, ...t.style },
        customStyle: { ...t.style },
    };
}

export function setPreset(key, { keepCustom = false } = {}) {
    const t = store();
    key = RENAMED[key] ?? key;
    t.preset = PRESETS[key] ? key : DEFAULT_PRESET;
    if (!keepCustom) { t.colors = {}; t.style = {}; }
    save();
    applyTheme();
}

export function setColor(role, value) {
    const t = store();
    if (value === null || value === undefined || value === '') delete t.colors[role];
    else t.colors[role] = value;
    save();
    applyTheme();
}

/** Change one part of the look (shape, font, ...). null goes back to the preset's. */
export function setStyle(part, value) {
    const t = store();
    const opts = STYLE_OPTIONS[part]?.options.map(o => o[0]) ?? [];
    if (value === null || value === undefined || !opts.includes(value) || value === PRESETS[t.preset].style?.[part]) delete t.style[part];
    else t.style[part] = value;
    save();
    applyTheme();
}

/**
 * What the surfaces actually look like right now. For the SillyTavern preset
 * they come from your SillyTavern theme, so they have to be measured rather
 * than read from the theme.
 */
function measuredSurfaces(colors) {
    const doc = globalThis.document;
    const probe = (prop, fallback) => {
        if (colors[prop]) return parseColor(colors[prop]);
        const v = safe(() => getComputedStyle(doc.documentElement).getPropertyValue(`--pc-${prop}`).trim());
        return parseColor(v) ?? parseColor(fallback);
    };
    const page = safe(() => parseColor(getComputedStyle(doc.body).backgroundColor)) ?? parseColor('#202024');
    const base = page && page.a > 0 ? page : parseColor('#202024');
    const panel = over(probe('panel', 'rgba(20,20,24,0.97)') ?? parseColor('#141418'), base);
    const block = over(probe('block', 'rgba(40,40,48,0.96)') ?? parseColor('#282830'), panel);
    return { panel, block };
}

/**
 * Put the theme on the page. Meaning colours are then checked against the
 * backgrounds they sit on, and nudged darker (or lighter) if they would be
 * hard to read, so a colour picked on a dark theme still works on a light one.
 */
export function applyTheme() {
    const doc = globalThis.document;
    if (!doc?.documentElement) return;
    const { colors, style, preset } = currentTheme();
    const root = doc.documentElement.style;
    const data = doc.documentElement.dataset;

    // The look: data attributes for style.css, and a few sizes as variables.
    for (const part of Object.keys(STYLE_OPTIONS)) data[`pc${part[0].toUpperCase()}${part.slice(1)}`] = style[part];
    // A theme with its own surfaces also styles SillyTavern's buttons and
    // fields inside the panel, which otherwise keep SillyTavern's colours.
    data.pcOwn = preset === 'sillytavern' && !colors.panel ? '0' : '1';
    const [r, rSm, rChip] = RADII[style.shape] ?? RADII.rounded;
    root.setProperty('--pc-r', `${r}px`);
    root.setProperty('--pc-r-sm', `${rSm}px`);
    root.setProperty('--pc-r-chip', `${rChip}px`);
    const [bw, ww] = WEIGHTS[style.weight] ?? WEIGHTS.normal;
    root.setProperty('--pc-bw', `${bw}px`);
    root.setProperty('--pc-wire-w', String(ww));
    if (FONTS[style.font]) root.setProperty('--pc-font', FONTS[style.font]);
    else root.removeProperty('--pc-font');
    for (const r of ROLES) root.removeProperty(`--pc-${r.key}`);
    root.removeProperty('--pc-panel-solid');
    root.removeProperty('--pc-on-accent');

    for (const r of ROLES) if (colors[r.key]) root.setProperty(`--pc-${r.key}`, colors[r.key]);
    if (colors.panel) root.setProperty('--pc-panel-solid', colors.panel);

    const { panel, block } = measuredSurfaces(colors);
    const light = luminance(panel) > 0.4;
    // Menus and popovers need a solid background. When the panel colour comes
    // from SillyTavern it is often see-through, so use what it looks like.
    if (!colors.panel) root.setProperty('--pc-panel-solid', toHex(panel));
    root.setProperty('--pc-on-accent', light ? '#ffffff' : '#1a1a1e');
    doc.documentElement.dataset.pcLight = light ? '1' : '0';

    for (const key of MEANING) {
        const c = parseColor(colors[key]);
        if (!c) continue;
        // Worst case of the two backgrounds these colours sit on.
        const bg = contrast(c, panel) < contrast(c, block) ? panel : block;
        const fitted = fitContrast(c, bg, 3);
        if (fitted !== c) root.setProperty(`--pc-${key}`, toHex(fitted));
    }
    // The canvas draws wires and its background from the look, so tell it.
    safe(() => doc.dispatchEvent(new CustomEvent('pc-theme')));
}

/** The font stack a look uses, for showing a preset's name in its own font. */
export function fontFor(style) {
    return FONTS[style?.font] ?? null;
}

/**
 * Things worth knowing about a theme: meaning colours too close to tell
 * apart, and colours hard to read on their background. Advice only.
 */
export function themeWarnings(colors = currentTheme().colors) {
    const out = [];
    const label = (k) => ROLES.find(r => r.key === k)?.label ?? k;
    const parsed = Object.fromEntries(MEANING.map(k => [k, parseColor(colors[k])]).filter(([, v]) => v));
    const keys = Object.keys(parsed);
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const d = distance(parsed[keys[i]], parsed[keys[j]]);
            if (d < 15) out.push({ kind: 'similar', roles: [keys[i], keys[j]], text: `"${label(keys[i])}" and "${label(keys[j])}" are very close. They will be hard to tell apart.` });
        }
    }
    const text = parseColor(colors.text), panel = parseColor(colors.panel), block = parseColor(colors.block);
    if (text && panel && contrast(text, panel) < 4.5) out.push({ kind: 'contrast', roles: ['text', 'panel'], text: 'The text is hard to read on the panel background.' });
    if (text && block && contrast(text, block) < 4.5) out.push({ kind: 'contrast', roles: ['text', 'block'], text: 'The text is hard to read on the block background.' });
    return out;
}

/* ------------------------------------------------------------------ */
/* sharing                                                             */
/* ------------------------------------------------------------------ */

export function exportTheme(name = null) {
    const { preset, custom, customStyle } = currentTheme();
    const changed = Object.keys(custom).length + Object.keys(customStyle).length;
    return JSON.stringify({ sillyCanvasTheme: 1, name: name || PRESETS[preset].name + (changed ? ' (custom)' : ''), base: preset, colors: custom, style: customStyle });
}

/** @returns {{ok: boolean, reason?: string, name?: string}} */
export function importTheme(text) {
    let o;
    try { o = JSON.parse(String(text ?? '').trim()); } catch { return { ok: false, reason: 'That is not a Silly Canvas theme. Paste the whole text you were given.' }; }
    if (!o || o.sillyCanvasTheme !== 1 || typeof o.colors !== 'object') return { ok: false, reason: 'That is not a Silly Canvas theme.' };
    const colors = {};
    for (const r of ROLES) {
        const v = o.colors[r.key];
        if (v !== undefined && parseColor(v)) colors[r.key] = toHex(parseColor(v));
    }
    const style = {};
    for (const [part, def] of Object.entries(STYLE_OPTIONS)) {
        const v = o.style?.[part];
        if (def.options.some(x => x[0] === v)) style[part] = v;
    }
    const t = store();
    const base = RENAMED[o.base] ?? o.base;
    t.preset = PRESETS[base] ? base : DEFAULT_PRESET;
    t.colors = colors;
    t.style = style;
    save();
    applyTheme();
    return { ok: true, name: String(o.name || 'Imported theme') };
}
