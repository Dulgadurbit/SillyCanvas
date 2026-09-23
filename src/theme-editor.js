/**
 * Silly Canvas: the theme picker and colour editor.
 *
 * One editor, shown in two places: the extension settings drawer and the
 * palette button in the canvas header. Colours change live as you pick them.
 */

import { safe } from './state.js?v=0.9.0';
import * as T from './theme.js?v=0.9.0';

const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

const editors = new Set();

/** Redraw every open editor (the drawer and the popover can both be open). */
function refreshAll() {
    for (const box of [...editors]) {
        if (!box.isConnected) { editors.delete(box); continue; }
        draw(box);
    }
}

/** Draw the theme editor into a container, and keep it current. */
export function renderThemeEditor(box) {
    editors.add(box);
    draw(box);
}

function swatches(colors) {
    const row = make('div', 'pc-th-swatches');
    for (const r of T.ROLES.filter(r => r.group === 'meaning')) {
        const s = make('span', 'pc-th-swatch');
        s.style.background = colors[r.key];
        s.title = r.label;
        row.append(s);
    }
    return row;
}

/** The colour a role has right now on screen, for roles the theme leaves to SillyTavern. */
function onScreen(role) {
    const v = safe(() => getComputedStyle(document.documentElement).getPropertyValue(`--pc-${role}`).trim());
    const c = T.parseColor(v);
    return c ? T.toHex(c) : '#808080';
}

function draw(box) {
    const open = box.querySelector('.pc-th-custom')?.open ?? false;
    const shareOpen = box.querySelector('.pc-th-share')?.open ?? false;
    box.innerHTML = '';
    box.classList.add('pc-theme-editor');
    const theme = T.currentTheme();

    // presets
    const presets = make('div', 'pc-th-presets');
    for (const [key, p] of Object.entries(T.PRESETS)) {
        const b = make('button', `pc-th-preset${key === theme.preset ? ' pc-on' : ''}`);
        b.type = 'button';
        b.append(make('span', 'pc-th-name', p.name), swatches({ ...p.colors, ...(key === theme.preset ? theme.custom : {}) }));
        b.title = p.note;
        b.addEventListener('click', () => {
            if (key === theme.preset) return;
            T.setPreset(key);
            refreshAll();
        });
        presets.append(b);
    }
    box.append(presets);
    box.append(make('div', 'pc-hint', T.PRESETS[theme.preset].note));

    // customise
    const custom = make('details', 'pc-th-custom');
    custom.open = open;
    const n = Object.keys(theme.custom).length;
    custom.append(make('summary', '', n ? `Your colours (${n} changed)` : 'Customise colours'));

    for (const group of ['surface', 'meaning']) {
        custom.append(make('div', 'pc-th-group', group === 'surface' ? 'Backgrounds and text' : 'What colours mean'));
        for (const r of T.ROLES.filter(x => x.group === group)) {
            const row = make('label', 'pc-th-row');
            const input = make('input', 'pc-th-color');
            input.type = 'color';
            const set = theme.colors[r.key];
            input.value = set && T.parseColor(set) ? T.toHex(T.parseColor(set)) : onScreen(r.key);
            input.addEventListener('input', () => T.setColor(r.key, input.value));
            input.addEventListener('change', refreshAll);
            const name = make('span', 'pc-th-label', r.label);
            row.append(input, name);
            if (!set) row.append(make('span', 'pc-th-from', 'from SillyTavern'));
            if (theme.custom[r.key]) {
                const reset = make('i', 'fa-solid fa-rotate-left pc-th-reset');
                reset.title = `Back to ${T.PRESETS[theme.preset].name}'s colour`;
                reset.addEventListener('click', (e) => { e.preventDefault(); T.setColor(r.key, null); refreshAll(); });
                row.append(reset);
            }
            custom.append(row);
        }
    }

    const warnings = T.themeWarnings(theme.colors);
    if (warnings.length) {
        const w = make('div', 'pc-th-warnings');
        for (const x of warnings) w.append(make('div', 'pc-th-warning', x.text));
        custom.append(w);
    }
    custom.append(make('div', 'pc-hint', 'On a light background, colours are darkened as needed so they stay readable.'));

    if (n) {
        const resetAll = make('button', 'menu_button pc-th-btn', `Back to ${T.PRESETS[theme.preset].name}`);
        resetAll.type = 'button';
        resetAll.addEventListener('click', () => { T.setPreset(theme.preset); refreshAll(); });
        custom.append(resetAll);
    }
    box.append(custom);

    // share
    const share = make('details', 'pc-th-share');
    share.open = shareOpen;
    share.append(make('summary', '', 'Share or import a theme'));
    const text = make('textarea', 'text_pole pc-th-text');
    text.rows = 3;
    text.placeholder = 'Paste a theme here to use it';
    const copy = make('button', 'menu_button pc-th-btn', 'Copy my theme');
    copy.type = 'button';
    const use = make('button', 'menu_button pc-th-btn', 'Use pasted theme');
    use.type = 'button';
    const msg = make('div', 'pc-hint pc-th-msg');
    copy.addEventListener('click', async () => {
        const s = T.exportTheme();
        text.value = s;
        const ok = await safe(() => navigator.clipboard.writeText(s).then(() => true, () => false), Promise.resolve(false));
        msg.textContent = ok ? 'Copied. Paste it anywhere to share.' : 'Select the text above and copy it.';
        text.select();
    });
    use.addEventListener('click', () => {
        const r = T.importTheme(text.value);
        if (!r.ok) { msg.textContent = r.reason; return; }
        refreshAll();
        const m = box.querySelector('.pc-th-msg');
        if (m) m.textContent = `Now using "${r.name}".`;
    });
    const btns = make('div', 'pc-th-btns');
    btns.append(copy, use);
    share.append(text, btns, msg);
    box.append(share);
}
