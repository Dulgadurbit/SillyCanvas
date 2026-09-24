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

import { settings, save, safe } from './state.js?v=0.10.0';

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
 * Built-in themes. "SillyTavern" leaves the surfaces to your SillyTavern
 * theme; the others set everything.
 */
export const PRESETS = {
    sillytavern: {
        name: 'SillyTavern',
        note: 'Follows your SillyTavern theme for backgrounds and text.',
        colors: {
            muted: '#9aa0a6',
            flow: '#7ab7ff', append: '#7fd18c', prepend: '#5fd4c8', generate: '#d48fe0',
            decider: '#ff8c42', warn: '#f0c36a', error: '#e08f8f',
        },
    },
    'dark-night': {
        name: 'Dark Night',
        note: 'Near black, cool greys, clear bright signals.',
        colors: {
            panel: '#0d1015', block: '#161b22', canvas: '#0a0d11', border: '#2a313c', text: '#d8dde4', muted: '#8b949e',
            flow: '#58a6ff', append: '#3fb950', prepend: '#39c5cf', generate: '#bc8cff',
            decider: '#f0883e', warn: '#e3c341', error: '#f85149',
        },
    },
    'blue-moon': {
        name: 'Blue Moon',
        note: 'Deep navy with pale moonlit accents.',
        colors: {
            panel: '#0e1a2f', block: '#15243e', canvas: '#0a1424', border: '#2b4066', text: '#dbe6ff', muted: '#8ea3c7',
            flow: '#7cc4ff', append: '#6ee7a8', prepend: '#5eead4', generate: '#b3a4ff',
            decider: '#ffb37a', warn: '#fde68a', error: '#ff9b9b',
        },
    },
    'purple-prose': {
        name: 'Purple Prose',
        note: 'Plum and violet, for florid storytelling.',
        colors: {
            panel: '#1a1226', block: '#251a35', canvas: '#140e1f', border: '#43305e', text: '#efe5fb', muted: '#ab98c4',
            flow: '#8fb8ff', append: '#7dd3a8', prepend: '#6fd6d0', generate: '#e39bff',
            decider: '#ff9e7a', warn: '#f7d774', error: '#ff7a93',
        },
    },
    'pink-blink': {
        name: 'Pink Blink',
        note: 'Light and rosy. The light theme of the set.',
        colors: {
            panel: '#fff0f6', block: '#ffffff', canvas: '#ffe3ee', border: '#f0b2cb', text: '#3b1f2b', muted: '#8f5d73',
            flow: '#1d5fd6', append: '#15803d', prepend: '#0f766e', generate: '#b0209f',
            decider: '#c2410c', warn: '#9a6700', error: '#d0203a',
        },
    },
    'brown-gown': {
        name: 'Brown Gown',
        note: 'Warm leather browns and parchment text.',
        colors: {
            panel: '#1f1712', block: '#2b2019', canvas: '#18120e', border: '#4d3a2b', text: '#f1e4d3', muted: '#b39b83',
            flow: '#8fb4d9', append: '#a3c77e', prepend: '#7cc7b5', generate: '#cfa3e0',
            decider: '#e8915a', warn: '#f0c36a', error: '#e27a6f',
        },
    },
};

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
    ui.theme ??= { preset: DEFAULT_PRESET, colors: {} };
    ui.theme.colors ??= {};
    if (!PRESETS[ui.theme.preset]) ui.theme.preset = DEFAULT_PRESET;
    return ui.theme;
}

/** The chosen preset plus your own changes. */
export function currentTheme() {
    const t = store();
    return { preset: t.preset, colors: { ...PRESETS[t.preset].colors, ...t.colors }, custom: { ...t.colors } };
}

export function setPreset(key, { keepCustom = false } = {}) {
    const t = store();
    t.preset = PRESETS[key] ? key : DEFAULT_PRESET;
    if (!keepCustom) t.colors = {};
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
    const { colors } = currentTheme();
    const root = doc.documentElement.style;
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
    const { preset, custom } = currentTheme();
    return JSON.stringify({ sillyCanvasTheme: 1, name: name || PRESETS[preset].name + (Object.keys(custom).length ? ' (custom)' : ''), base: preset, colors: custom });
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
    const t = store();
    t.preset = PRESETS[o.base] ? o.base : DEFAULT_PRESET;
    t.colors = colors;
    save();
    applyTheme();
    return { ok: true, name: String(o.name || 'Imported theme') };
}
