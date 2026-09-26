/**
 * Silly Canvas — the State block's own window.
 *
 * A State block holds values that change as the chat goes on. They are worked
 * out again from the whole chat every time, so what a value really has is a
 * history. This window shows it that way:
 *
 *   left    the values, each as a bar with its stages and where it is now
 *   middle  one value across the chat: a chart with the stage zones behind
 *           it and a dot wherever a rule changed it; a slider to look at any
 *           message and see what would be sent there; and a box to try a
 *           message before it happens
 *   tabs    Stages (a ladder: range, name, and what each stage sends: text,
 *           a library prompt, or its own dot to switch blocks on), Rules
 *           (as sentences, with how often each fired), and Range & output
 *
 * It edits the block directly; the canvas and preview follow along.
 */

import { computeState, stageFor, stageText, ensureStageIds, stagePortId } from './statevals.js?v=0.16.0';
import { newStateValue, uid, ROLES } from './state.js?v=0.16.0';

const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
};
const num = (v, d = 0) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));

const WHEN = [
    ['turn', 'Every turn'],
    ['every', 'Every few turns'],
    ['phrase', 'When words appear'],
    ['formula', 'When a formula holds'],
];
const OPS = [['add', 'add'], ['sub', 'subtract'], ['set', 'set it to'], ['mul', 'multiply it by'], ['reset', 'reset it to the start']];

/** Colours for stage zones, by position, from the theme's own signals. */
// Stages are usually listed from high to low, so the first few read as a
// gentle slope: green, yellow, orange, red; then the other signals.
const ZONE_VARS = ['--pc-append', '--pc-warn', '--pc-decider', '--pc-error', '--pc-generate', '--pc-flow', '--pc-prepend'];
const zoneColor = (i) => `var(${ZONE_VARS[i % ZONE_VARS.length]})`;

let open = null;

/** Whether the window is showing. */
export function isStateWindowOpen() {
    return !!open?.wrap?.isConnected;
}

/** Close it, if it is open. */
export function closeStateWindow() {
    open?.close();
}

/**
 * Open the window for one State block.
 * @param {object} node  the State block
 * @param {object} api   what the panel lends it:
 *   host        element to put the window in
 *   chat()      the chat right now
 *   changed()   the block was edited (touch the canvas, redraw it)
 *   refresh()   re-read the chat (after setting a value by hand)
 *   substitute(text)  fill in {{char}} and the other macros, for showing what is sent
 *   nudge(node, v, value)  set a value by hand from now on
 *   destinations(node, port)  element listing where a dot is wired, with a picker
 *   formulaNote(src, node)    a short check of a formula
 *   library     { list(), get(id), create({name, content, role}), update(id, patch) }
 *   confirm(text)              ask yes or no
 *   dropWires(node, test)      remove the block's wires from dots whose port passes the test
 *   ui          { field, dropdown, checkline, mkBtn, toast }
 */
export function openStateWindow(node, api) {
    closeStateWindow();
    const { field, dropdown, checkline, mkBtn, toast } = api.ui;
    node.values ??= [];
    for (const v of node.values) ensureStageIds(v);

    const wrap = el('div', 'pc-sw-backdrop');
    const box = el('div', 'pc-sw');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', `State: ${node.title || 'State'}`);
    wrap.append(box);
    api.host.append(wrap);

    const ui = {
        valueId: node.values[0]?.id ?? null,
        tab: 'stages',
        at: null,              // message number the slider is on; null = now
        guide: !node.values.length,
        tryText: '',
        tryWho: 'user',
    };

    const close = () => {
        wrap.remove();
        document.removeEventListener('keydown', onKey, true);
        if (open?.wrap === wrap) open = null;
        api.onClose?.();
    };
    const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        e.preventDefault();
        close();
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    open = { wrap, close, node };

    /** The value being looked at. */
    const value = () => node.values.find(v => v.id === ui.valueId) ?? node.values[0] ?? null;
    /** The chat replayed, with every step kept. */
    const history = () => computeState(node, api.chat() ?? [], { timeline: true });

    /* -------------------------------------------------------------- */
    /* drawing                                                         */
    /* -------------------------------------------------------------- */

    /** A structural change: rebuild everything. */
    const redraw = () => { api.changed(); render(); };
    /** Typing: keep focus, just refresh what shows the numbers. */
    const soft = () => { api.changed(); paintLive(); };

    function render() {
        const scroll = box.querySelector('.pc-sw-main')?.scrollTop ?? 0;
        box.innerHTML = '';
        box.append(header(), body());
        const main = box.querySelector('.pc-sw-main');
        if (main) main.scrollTop = scroll;
        paintLive();
    }

    function header() {
        const h = el('div', 'pc-sw-head');
        const icon = el('i', 'fa-solid fa-gauge-high pc-sw-icon');
        const title = el('input', 'text_pole pc-sw-title');
        title.value = node.title ?? '';
        title.placeholder = 'State';
        title.addEventListener('input', () => { node.title = title.value; api.changed(); });
        const on = checkline('Switched on', node.enabled !== false, (x) => { node.enabled = x; redraw(); });
        on.classList.add('pc-sw-on');
        const help = mkBtn('fa-circle-question', 'How State blocks work', () => { ui.guide = !ui.guide; render(); }, `pc-sw-helpbtn${ui.guide ? ' pc-on' : ''}`);
        const x = mkBtn('fa-xmark', 'Close (Esc)', close, 'pc-sw-close');
        h.append(icon, title, on, help, x);
        return h;
    }

    function body() {
        const b = el('div', 'pc-sw-body');
        b.append(sidebar());
        const main = el('div', 'pc-sw-main');
        if (ui.guide) main.append(guide());
        const v = value();
        if (!v) {
            main.append(empty());
        } else {
            main.append(valueHead(v), chartCard(v), tryCard(v), tabs(v));
        }
        b.append(main);
        return b;
    }

    function guide() {
        const g = el('div', 'pc-sw-guide');
        g.append(el('b', '', 'How it works'));
        const ol = el('ol');
        for (const t of [
            'A value is a number (energy, hunger, mana, a level) or a word (a mood). It starts somewhere.',
            'Rules change it: every turn, every few turns, when words appear in a message, or when a formula holds.',
            'Stages turn a number into words: 0–3 is "exhausted", 4–7 "tired"... Each stage sends its own text, or a prompt from your library.',
            'Give the stages their own dots and wire each one to any block: that block is only switched on during that stage.',
            'Nothing is counted up and saved. The values are worked out from the chat as it is, so swipes, edits and deleted messages never count twice.',
        ]) ol.append(el('li', '', t));
        g.append(ol);
        g.append(el('div', 'pc-hint', 'In any text: {{state::energy}} is the number, {{stage::energy}} its stage name, {{statetext::energy}} what its stage sends. In a Decider or wire condition, the formula energy <= 2.'));
        return g;
    }

    function empty() {
        const e = el('div', 'pc-sw-empty');
        e.append(el('div', 'pc-sw-empty-title', 'No values yet'));
        e.append(el('div', 'pc-hint', 'Start with one of these, and change anything afterwards.'));
        const row = el('div', 'pc-sw-presets');
        for (const [label, make] of PRESETS) {
            const b = el('div', 'pc-btn menu_button', label);
            b.addEventListener('click', () => { const v = make(); node.values.push(v); ui.valueId = v.id; ui.guide = false; redraw(); });
            row.append(b);
        }
        e.append(row);
        return e;
    }

    /* ---------------- left: the values as bars ---------------- */

    function sidebar() {
        const side = el('div', 'pc-sw-side');
        side.append(el('div', 'pc-sw-side-title', 'Values'));
        const list = el('div', 'pc-sw-values');
        for (const v of node.values) {
            const item = el('div', `pc-sw-value${v.id === value()?.id ? ' pc-on' : ''}`);
            item.dataset.value = v.id;
            const top = el('div', 'pc-sw-value-top');
            top.append(el('b', 'pc-sw-value-name', v.name || 'value'), el('span', 'pc-sw-value-now'));
            item.append(top);
            if (v.kind !== 'text') item.append(bar(v));
            item.append(el('div', 'pc-sw-value-stage'));
            item.addEventListener('click', () => { ui.valueId = v.id; ui.at = null; render(); });
            list.append(item);
        }
        side.append(list);
        const add = el('div', 'pc-btn menu_button pc-sw-add');
        add.innerHTML = '<i class="fa-solid fa-plus"></i> Add a value';
        add.addEventListener('click', () => {
            const v = newStateValue(node.values.length ? `value${node.values.length + 1}` : 'energy');
            node.values.push(v);
            ui.valueId = v.id;
            ui.at = null;
            redraw();
        });
        side.append(add);
        side.append(field('Sent as', dropdown(ROLES.map(r => [r, r]), node.role || 'system', (x) => { node.role = x; api.changed(); })));
        return side;
    }

    /** A value's range as a bar, its stages as zones, and a marker for where it is. */
    function bar(v) {
        const b = el('div', 'pc-sw-bar');
        const [lo, hi] = range(v);
        (v.stages ?? []).forEach((s, i) => {
            const from = Math.max(lo, num(s.from, lo)), to = Math.min(hi, num(s.to, hi));
            if (to < from) return;
            const z = el('div', 'pc-sw-bar-zone');
            z.style.left = `${pct(from - 0.5, lo, hi)}%`;
            z.style.width = `${Math.max(1, pct(to + 0.5, lo, hi) - pct(from - 0.5, lo, hi))}%`;
            z.style.setProperty('--z', zoneColor(i));
            z.title = `${s.name || 'stage'}: ${s.from ?? ''}–${s.to ?? ''}`;
            b.append(z);
        });
        const mark = el('div', 'pc-sw-bar-mark');
        b.append(mark);
        return b;
    }

    /* ---------------- middle: one value ---------------- */

    function valueHead(v) {
        const h = el('div', 'pc-sw-vhead');
        const name = el('input', 'text_pole pc-sw-vname');
        name.value = v.name ?? '';
        name.placeholder = 'name, e.g. energy';
        name.title = 'Its name in formulas and in {{state::name}}';
        name.addEventListener('input', () => {
            v.name = name.value.trim().replace(/\s+/g, '_');
            api.changed();
            const side = box.querySelector(`.pc-sw-value[data-value="${CSS.escape(v.id)}"] .pc-sw-value-name`);
            if (side) side.textContent = v.name || 'value';
        });
        const kind = segmented([['number', 'A number'], ['text', 'A word']], v.kind ?? 'number', (x) => { v.kind = x; if (x === 'text' && typeof v.start !== 'string') v.start = 'calm'; if (x === 'number') v.start = num(v.start, 10); redraw(); });
        const i = node.values.indexOf(v);
        const tools = el('div', 'pc-sw-tools');
        tools.append(
            mkBtn('fa-arrow-up', 'Move up', () => { if (i > 0) { [node.values[i - 1], node.values[i]] = [node.values[i], node.values[i - 1]]; redraw(); } }, 'pc-key-tool'),
            mkBtn('fa-clone', 'Duplicate this value (without its wires)', () => {
                const copy = structuredClone(v);
                copy.id = newStateValue().id;
                copy.name = `${v.name || 'value'}_2`;
                for (const s of copy.stages ?? []) s.id = undefined;
                ensureStageIds(copy);
                node.values.splice(i + 1, 0, copy);
                ui.valueId = copy.id;
                redraw();
            }, 'pc-key-tool'),
            mkBtn('fa-trash-can', 'Remove this value and its wires', () => {
                node.values.splice(i, 1);
                api.dropWires(node, (port) => port === v.id || String(port).startsWith(`${v.id}:`));
                ui.valueId = node.values[Math.max(0, i - 1)]?.id ?? null;
                redraw();
            }, 'pc-key-tool pc-danger'),
        );
        h.append(name, kind, tools);
        return h;
    }

    /** The chart of one value across the chat, with its stages behind it. */
    function chartCard(v) {
        const card = el('div', 'pc-sw-card pc-sw-chartcard');
        const head = el('div', 'pc-sw-card-head');
        head.append(el('b', '', `${v.name || 'value'} over this chat`));
        const legend = el('span', 'pc-hint pc-sw-legend');
        head.append(legend);
        card.append(head);
        const chart = el('div', 'pc-sw-chart');
        card.append(chart);
        const scrub = el('div', 'pc-sw-scrub');
        const slider = el('input', 'pc-sw-slider');
        slider.type = 'range';
        slider.min = '0';
        slider.step = '1';
        const back = el('div', 'pc-btn menu_button pc-sw-now', 'Now');
        back.title = 'Back to the latest message';
        back.addEventListener('click', () => { ui.at = null; paintLive(); });
        slider.addEventListener('input', () => {
            const max = Number(slider.max);
            ui.at = Number(slider.value) >= max ? null : Number(slider.value);
            paintLive();
        });
        scrub.append(slider, back);
        card.append(scrub);
        const read = el('div', 'pc-sw-readout');
        card.append(read);
        return card;
    }

    /** Try a message before it happens: what would change. */
    function tryCard(v) {
        const card = el('div', 'pc-sw-card pc-sw-try');
        const head = el('div', 'pc-sw-card-head');
        head.append(el('b', '', 'Try a message'));
        head.append(el('span', 'pc-hint', 'What would the next message do? Nothing is sent or saved.'));
        card.append(head);
        const row = el('div', 'pc-sw-tryrow');
        const who = dropdown([['user', 'You write'], ['char', 'The character writes']], ui.tryWho, (x) => { ui.tryWho = x; paintTry(); });
        const text = el('input', 'text_pole');
        text.placeholder = v.kind === 'text' ? 'e.g. She smiles and relaxes.' : 'e.g. I rest by the fire for a while.';
        text.value = ui.tryText;
        text.addEventListener('input', () => { ui.tryText = text.value; paintTry(); });
        row.append(who, text);
        card.append(row);
        card.append(el('div', 'pc-sw-tryout'));
        return card;
    }

    function tabs(v) {
        const wrapTabs = el('div', 'pc-sw-tabs');
        const bar = el('div', 'pc-sw-tabbar');
        const names = v.kind === 'text'
            ? [['rules', 'Rules'], ['output', 'Start & output']]
            : [['stages', 'Stages'], ['rules', 'Rules'], ['output', 'Range & output']];
        if (!names.some(([k]) => k === ui.tab)) ui.tab = names[0][0];
        for (const [k, label] of names) {
            const t = el('div', `pc-sw-tab${ui.tab === k ? ' pc-on' : ''}`, label);
            if (k === 'stages') t.append(el('span', 'pc-sw-count', String((v.stages ?? []).length)));
            if (k === 'rules') t.append(el('span', 'pc-sw-count', String((v.rules ?? []).length)));
            t.addEventListener('click', () => { ui.tab = k; render(); });
            bar.append(t);
        }
        wrapTabs.append(bar);
        const pane = el('div', 'pc-sw-pane');
        if (ui.tab === 'stages') pane.append(...stagesPane(v));
        else if (ui.tab === 'rules') pane.append(...rulesPane(v));
        else pane.append(...outputPane(v));
        wrapTabs.append(pane);
        return wrapTabs;
    }

    /* ---------------- stages: the ladder ---------------- */

    function stagesPane(v) {
        const out = [];
        v.stages ??= [];
        ensureStageIds(v);
        const tools = el('div', 'pc-sw-stagetools');
        const add = el('div', 'pc-btn menu_button');
        add.innerHTML = '<i class="fa-solid fa-plus"></i> Add a stage';
        add.addEventListener('click', () => {
            const [lo, hi] = range(v);
            v.stages.push({ id: uid('s'), from: lo, to: hi, name: '', text: '' });
            redraw();
        });
        const split = el('div', 'pc-sw-split');
        split.append(el('span', 'pc-hint', 'Split the range into'));
        for (const k of [2, 3, 4, 5]) {
            const b = el('div', 'pc-btn menu_button pc-sw-splitbtn', String(k));
            b.title = `Replace the stages with ${k} even ones`;
            b.addEventListener('click', async () => {
                if (v.stages.some(s => String(s.text ?? '').trim() || s.promptId) && !await api.confirm(`Replace the ${v.stages.length} stages of "${v.name}" with ${k} new, empty ones?`)) return;
                splitStages(v, k);
                redraw();
            });
            split.append(b);
        }
        tools.append(add, split);
        out.push(tools);
        out.push(checkline('Give each stage its own dot on the block', !!v.stageDots, (x) => {
            v.stageDots = x;
            if (!x) api.dropWires(node, (port) => String(port).startsWith(`${v.id}:`));
            redraw();
        }));
        out.push(el('div', 'pc-hint', v.stageDots
            ? 'Wire a stage’s dot to any block, or a whole group: it is switched on only while the value is in that stage. Its text (if any) goes along too.'
            : 'With dots, a stage can switch on any block instead of sending text: a prompt, a Generate block, a group.'));

        if (!v.stages.length) {
            out.push(el('div', 'pc-sw-none', 'No stages yet: the value is sent as a number. Split the range to start.'));
            return out;
        }
        const ladder = el('div', 'pc-sw-ladder');
        v.stages.forEach((s, i) => ladder.append(stageCard(v, s, i)));
        out.push(ladder);
        const gaps = coverage(v);
        if (gaps) out.push(el('div', 'pc-hint pc-warn-text', gaps));
        return out;
    }

    function stageCard(v, s, i) {
        const card = el('div', 'pc-sw-stage');
        card.dataset.stage = s.id;
        card.style.setProperty('--z', zoneColor(i));
        const top = el('div', 'pc-sw-stage-top');
        const sw = el('span', 'pc-sw-swatch');
        const from = numIn(s.from, 'from', (x) => { s.from = x === '' ? '' : Number(x); soft(); });
        const to = numIn(s.to, 'to', (x) => { s.to = x === '' ? '' : Number(x); soft(); });
        const name = el('input', 'text_pole pc-sw-stagename');
        name.value = s.name ?? '';
        name.placeholder = 'name, e.g. tired';
        name.addEventListener('input', () => { s.name = name.value; soft(); });
        const now = el('span', 'pc-sw-nowtag', 'now');
        const tools = el('div', 'pc-sw-tools');
        tools.append(
            mkBtn('fa-arrow-up', 'Move up (checked first when stages overlap)', () => { if (i > 0) { [v.stages[i - 1], v.stages[i]] = [v.stages[i], v.stages[i - 1]]; redraw(); } }, 'pc-key-tool'),
            mkBtn('fa-xmark', 'Remove this stage', () => {
                v.stages.splice(i, 1);
                api.dropWires(node, (port) => port === stagePortId(v, s));
                redraw();
            }, 'pc-key-tool'),
        );
        top.append(sw, from, el('span', 'pc-hint', 'to'), to, name, now, tools);
        card.append(top);

        // What it sends
        const mode = s.source === 'prompt' ? 'prompt' : 'text';
        const sends = el('div', 'pc-sw-sends');
        sends.append(el('span', 'pc-label', 'Sends'), segmented([['text', 'Its own text'], ['prompt', 'A library prompt']], mode, async (x) => {
            if (x === 'prompt') {
                s.source = 'prompt';
                // Nothing typed is lost: it becomes a library prompt.
                if (!s.promptId && String(s.text ?? '').trim()) {
                    const p = api.library.create({ name: `${v.name || 'value'}: ${s.name || 'stage'}`, content: s.text, role: node.role || 'system' });
                    s.promptId = p.id;
                    toast(`Your text is now the library prompt "${p.name}".`, 'success');
                }
            } else {
                delete s.source;
                if (!String(s.text ?? '').trim() && s.promptId) s.text = api.library.get(s.promptId)?.content ?? '';
            }
            redraw();
        }));
        card.append(sends);

        if (mode === 'text') {
            const t = el('textarea', 'text_pole pc-textarea');
            t.rows = 2;
            t.placeholder = v.stageDots
                ? 'Text to send at this stage (optional: its dot switches blocks on either way)'
                : 'What is sent at this stage, e.g. {{char}} is getting tired. Leave empty to send nothing.';
            t.value = s.text ?? '';
            t.addEventListener('input', () => { s.text = t.value; soft(); });
            card.append(t);
        } else {
            const list = api.library.list();
            const pairs = [['', list.length ? '— choose a prompt —' : 'Your library has no prompts yet'], ...list.map(p => [p.id, `${p.folder ? `${p.folder} › ` : ''}${p.name}`])];
            if (s.promptId && !list.some(p => p.id === s.promptId)) pairs.push([s.promptId, '(a prompt that is gone)']);
            const pick = dropdown(pairs, s.promptId ?? '', (x) => { s.promptId = x || undefined; redraw(); });
            const row = el('div', 'pc-sw-promptrow');
            row.append(pick);
            row.append(mkBtn('fa-plus', 'A new library prompt for this stage', () => {
                const p = api.library.create({ name: `${v.name || 'value'}: ${s.name || 'stage'}`, content: '', role: node.role || 'system' });
                s.promptId = p.id;
                redraw();
            }, 'pc-key-tool'));
            card.append(row);
            const linked = s.promptId ? api.library.get(s.promptId) : null;
            if (linked) {
                // Edit the library prompt right here. It is the same prompt
                // everywhere it is used, so the note says so.
                const t = el('textarea', 'text_pole pc-textarea pc-sw-linked');
                t.rows = 3;
                t.value = linked.content ?? '';
                t.placeholder = 'This library prompt is empty.';
                t.addEventListener('input', () => { api.library.update(linked.id, { content: t.value }); soft(); });
                card.append(t);
                card.append(el('div', 'pc-hint', `Linked to "${linked.name}" in your library. Editing it here changes it everywhere it is used.`));
            } else {
                card.append(el('div', 'pc-hint', s.promptId ? 'That prompt is no longer in the library. Pick another.' : 'Pick a prompt from your library. It stays linked: change it there and this stage sends the new text.'));
            }
        }

        if (v.stageDots) {
            const dot = el('div', 'pc-sw-dot');
            dot.append(api.destinations(node, { id: stagePortId(v, s), name: s.name || 'stage' }));
            dot.append(el('div', 'pc-hint', 'Blocks its dot goes to are switched on only during this stage.'));
            card.append(dot);
        }
        return card;
    }

    /* ---------------- rules as sentences ---------------- */

    function rulesPane(v) {
        const out = [];
        v.rules ??= [];
        const fired = {};
        for (const e of history().log) if (e.valueId === v.id && e.ruleId) fired[e.ruleId] = (fired[e.ruleId] ?? 0) + 1;
        if (!v.rules.length) out.push(el('div', 'pc-sw-none', 'No rules: the value stays where it starts, unless you set it by hand.'));
        v.rules.forEach((r, ri) => {
            r.id ??= uid('r');
            const card = el('div', 'pc-sw-rule');
            const line = el('div', 'pc-sw-sentence');
            line.append(dropdown(WHEN, r.when ?? 'turn', (x) => { r.when = x; redraw(); }));
            if (r.when === 'every') line.append(el('span', '', 'every'), numIn(r.n ?? 2, '2', (x) => { r.n = Math.max(1, Number(x) || 1); soft(); }), el('span', '', 'turns'));
            if (r.when === 'phrase') line.append(el('span', '', 'in'), dropdown([['any', 'any message'], ['char', 'the character’s replies'], ['user', 'your messages']], r.who ?? 'any', (x) => { r.who = x; soft(); }));
            line.append(el('span', 'pc-sw-comma', ','));
            line.append(dropdown(OPS, r.op ?? 'add', (x) => { r.op = x; redraw(); }));
            if (r.op !== 'reset') {
                const amt = el('input', 'text_pole pc-sw-amount');
                amt.value = r.amount ?? '';
                amt.placeholder = v.kind === 'text' ? 'text, or a formula' : '1, or a formula';
                amt.addEventListener('input', () => { r.amount = amt.value; soft(); });
                line.append(amt);
            }
            const count = fired[r.id] ?? 0;
            const stat = el('span', `pc-sw-fired${count ? '' : ' pc-sw-fired-none'}`, count ? `${count}× in this chat` : 'not yet');
            stat.title = 'How often this rule changed the value in the chat so far';
            line.append(stat, mkBtn('fa-xmark', 'Remove this rule', () => { v.rules.splice(ri, 1); redraw(); }, 'pc-key-tool'));
            card.append(line);
            if (r.when === 'phrase') {
                const terms = el('textarea', 'text_pole pc-textarea');
                terms.rows = 2;
                terms.placeholder = 'Words or phrases, one per line or separated by commas: sleeps, naps, goes to bed';
                terms.value = r.terms ?? '';
                terms.addEventListener('input', () => { r.terms = terms.value; soft(); paintTry(); });
                card.append(terms);
                card.append(checkline('Not after "didn’t", "refuses", "never"…', r.negation !== false, (x) => { r.negation = x; soft(); }));
            }
            if (r.when === 'formula') {
                const f = el('input', 'text_pole');
                f.value = r.formula ?? '';
                f.placeholder = 'e.g. hunger >= 8 and turn % 2 == 0';
                const msg = el('div', 'pc-hint');
                const check = () => { msg.textContent = api.formulaNote(r.formula, node); };
                f.addEventListener('input', () => { r.formula = f.value; soft(); check(); });
                check();
                card.append(f, msg);
            }
            out.push(card);
        });
        const add = el('div', 'pc-sw-addrule');
        add.append(el('span', 'pc-hint', 'Add a rule:'));
        for (const [when, label, make] of [
            ['turn', 'every turn', () => ({ when: 'turn', op: v.kind === 'text' ? 'set' : 'sub', amount: v.kind === 'text' ? '' : '1' })],
            ['phrase', 'when words appear', () => ({ when: 'phrase', op: v.kind === 'text' ? 'set' : 'add', amount: v.kind === 'text' ? '' : '3', terms: '', who: 'any' })],
            ['every', 'every few turns', () => ({ when: 'every', n: 3, op: 'sub', amount: '1' })],
            ['formula', 'when a formula holds', () => ({ when: 'formula', formula: '', op: 'set', amount: '' })],
        ]) {
            const b = el('div', 'pc-btn menu_button', label);
            b.dataset.when = when;
            b.addEventListener('click', () => { v.rules.push({ id: uid('r'), ...make() }); redraw(); });
            add.append(b);
        }
        out.push(add);
        out.push(el('div', 'pc-hint', 'Rules run in order, on every message of the chat. Amounts can be formulas: energy / 2, turn, hunger + 1.'));
        return out;
    }

    /* ---------------- range and output ---------------- */

    function outputPane(v) {
        const out = [];
        if (v.kind === 'text') {
            const start = el('input', 'text_pole');
            start.value = v.start ?? '';
            start.placeholder = 'e.g. calm';
            start.addEventListener('input', () => { v.start = start.value; soft(); });
            out.push(field('Starts as', start));
        } else {
            const r = el('div', 'pc-sw-range');
            r.append(el('span', 'pc-hint', 'Starts at'), numIn(v.start, 'start', (x) => { v.start = x === '' ? 0 : Number(x); soft(); }),
                el('span', 'pc-hint', 'and stays between'), numIn(v.min, 'no min', (x) => { v.min = x === '' ? '' : Number(x); soft(); }),
                el('span', 'pc-hint', 'and'), numIn(v.max, 'no max', (x) => { v.max = x === '' ? '' : Number(x); soft(); }));
            out.push(field('Range', r));
        }
        out.push(field('Its own dot sends', dropdown([
            ['text', v.kind === 'text' ? 'the word' : 'what its stage sends'],
            ['number', v.kind === 'text' ? 'the word' : 'the number'],
            ['stage', 'the stage name'],
        ], v.output ?? 'text', (x) => { v.output = x; soft(); }), 'When there is nothing to send, its wires carry nothing, and an Activate wire from it switches nothing on.'));
        out.push(field('Its dot goes to', api.destinations(node, { id: v.id, name: v.name })));

        const setRow = el('div', 'pc-sw-range');
        const setBox = el('input', v.kind === 'text' ? 'text_pole' : 'text_pole pc-select-num');
        if (v.kind !== 'text') setBox.type = 'number';
        setBox.placeholder = v.kind === 'text' ? 'new word' : 'new value';
        const setBtn = el('div', 'pc-btn menu_button', 'Set now');
        setBtn.addEventListener('click', async () => {
            if (setBox.value === '') return;
            await api.nudge(node, v, setBox.value);
            await api.refresh();
            redraw();
        });
        setRow.append(setBox, setBtn);
        out.push(field('Set it by hand', setRow, 'From the latest message on. Kept on that message, so it goes if the message is deleted or swiped away.'));
        out.push(el('div', 'pc-hint', `Use it anywhere: {{state::${v.name || 'value'}}} is the ${v.kind === 'text' ? 'word' : 'number'}, {{stage::${v.name || 'value'}}} the stage name, {{statetext::${v.name || 'value'}}} what its stage sends.`));
        return out;
    }

    /* -------------------------------------------------------------- */
    /* live parts: redrawn on every edit without losing focus         */
    /* -------------------------------------------------------------- */

    function paintLive() {
        const h = history();
        const last = h.timeline.at(-1);
        // left bars
        for (const v of node.values) {
            const item = box.querySelector(`.pc-sw-value[data-value="${CSS.escape(v.id)}"]`);
            if (!item) continue;
            const val = last.values[v.id];
            const st = stageFor(v, val);
            item.querySelector('.pc-sw-value-now').textContent = `${val}${v.kind !== 'text' && v.max !== '' && v.max != null ? ` / ${v.max}` : ''}`;
            item.querySelector('.pc-sw-value-stage').textContent = st?.name ? st.name : (v.stages ?? []).length ? 'no stage' : '';
            const mark = item.querySelector('.pc-sw-bar-mark');
            if (mark) { const [lo, hi] = range(v); mark.style.left = `${pct(num(val), lo, hi)}%`; }
        }
        const v = value();
        if (!v) return;
        paintChart(v, h);
        paintTry();
        // stage cards: which one is now
        const at = ui.at === null ? last : h.timeline[Math.min(ui.at, h.timeline.length - 1)];
        const st = stageFor(v, at.values[v.id]);
        for (const c of box.querySelectorAll('.pc-sw-stage')) c.classList.toggle('pc-sw-stage-now', c.dataset.stage === st?.id);
    }

    function paintChart(v, h) {
        const chart = box.querySelector('.pc-sw-chart');
        const slider = box.querySelector('.pc-sw-slider');
        const read = box.querySelector('.pc-sw-readout');
        const legend = box.querySelector('.pc-sw-legend');
        if (!chart) return;
        chart.innerHTML = '';
        const line = h.timeline;
        const n = line.length - 1;                     // messages
        const at = ui.at === null ? n : Math.min(ui.at, n);
        slider.max = String(Math.max(1, n));
        slider.value = String(at);
        slider.disabled = n < 1;
        const events = h.log.filter(e => e.valueId === v.id);
        legend.textContent = n ? `${n} message${n === 1 ? '' : 's'} · ${h.turn} turn${h.turn === 1 ? '' : 's'} · changed ${events.length}×` : 'no chat open';

        const W = 760, H = 190, L = 44, R = 90, T = 12, B = 24;
        const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pc-sw-svg', role: 'img' });
        s.setAttribute('aria-label', `${v.name} across the chat`);
        const x = (i) => L + (n ? (i / n) : 0) * (W - L - R);

        if (v.kind === 'text') {
            // A word does not chart: show its changes as a strip of labels.
            const words = [];
            let prev;
            line.forEach((p, i) => { const w = p.values[v.id]; if (w !== prev) { words.push([i, w]); prev = w; } });
            const y = H / 2;
            s.append(svg('line', { x1: L, y1: y, x2: W - R, y2: y, class: 'pc-sw-axis' }));
            words.forEach(([i, w], k) => {
                const nx = k + 1 < words.length ? x(words[k + 1][0]) : x(n);
                s.append(svg('rect', { x: x(i), y: y - 14, width: Math.max(2, nx - x(i)), height: 28, rx: 3, class: 'pc-sw-band', style: `--z:${zoneColor(k)}` }));
                const t = svg('text', { x: x(i) + 4, y: y + 4, class: 'pc-sw-bandlabel' });
                t.textContent = String(w);
                s.append(t);
            });
        } else {
            const [lo, hi] = chartRange(v, line);
            const y = (val) => T + (1 - (num(val) - lo) / ((hi - lo) || 1)) * (H - T - B);
            // stage zones
            (v.stages ?? []).forEach((st, i) => {
                const a = Math.max(lo, num(st.from, lo) - 0.5), b = Math.min(hi, num(st.to, hi) + 0.5);
                if (b <= a) return;
                s.append(svg('rect', { x: L, y: y(b), width: W - L - R, height: Math.max(1, y(a) - y(b)), class: 'pc-sw-band', style: `--z:${zoneColor(i)}` }));
                const t = svg('text', { x: W - R + 6, y: (y(a) + y(b)) / 2 + 4, class: 'pc-sw-bandlabel' });
                t.textContent = st.name || `${st.from ?? ''}–${st.to ?? ''}`;
                s.append(t);
            });
            // axis ticks: min, max, and the start
            for (const val of [...new Set([lo, hi])]) {
                const t = svg('text', { x: L - 6, y: y(val) + 4, class: 'pc-sw-tick', 'text-anchor': 'end' });
                t.textContent = String(Math.round(val * 100) / 100);
                s.append(t);
                s.append(svg('line', { x1: L, y1: y(val), x2: W - R, y2: y(val), class: 'pc-sw-grid' }));
            }
            // the value, as steps: it changes on a message and holds until the next change
            if (n) {
                let d = `M ${x(0)} ${y(line[0].values[v.id])}`;
                for (let i = 1; i <= n; i++) d += ` H ${x(i)} V ${y(line[i].values[v.id])}`;
                s.append(svg('path', { d, class: 'pc-sw-line' }));
                // a dot where rules changed it, one per message
                const byMsg = new Map();
                for (const e of events) { const l = byMsg.get(e.index) ?? []; l.push(e); byMsg.set(e.index, l); }
                for (const [i, list] of byMsg) {
                    const hand = list.some(e => e.byHand);
                    const c = svg('circle', { cx: x(i), cy: y(line[i].values[v.id]), r: hand ? 4.5 : 3, class: `pc-sw-event${hand ? ' pc-sw-event-hand' : ''}` });
                    const tip = svg('title');
                    tip.textContent = `Message ${i}: ${list.map(e => `${e.why} (${e.from} → ${e.to})`).join('; ')}`;
                    c.append(tip);
                    s.append(c);
                }
            } else {
                const t = svg('text', { x: (L + W - R) / 2, y: H / 2, class: 'pc-sw-tick', 'text-anchor': 'middle' });
                t.textContent = `Starts at ${v.start ?? 0}. Open a chat to see it change.`;
                s.append(t);
                s.append(svg('circle', { cx: x(0), cy: y(line[0].values[v.id]), r: 4, class: 'pc-sw-event' }));
            }
        }
        // the slider's position
        if (n) {
            s.append(svg('line', { x1: x(at), y1: T - 4, x2: x(at), y2: H - B + 4, class: 'pc-sw-cursor' }));
            const lab = svg('text', { x: x(at), y: H - 6, class: 'pc-sw-tick', 'text-anchor': at > n * 0.8 ? 'end' : at < n * 0.2 ? 'start' : 'middle' });
            lab.textContent = at === n ? 'now' : `message ${at}`;
            s.append(lab);
        }
        chart.append(s);

        // what is sent at that point
        read.innerHTML = '';
        const p = line[at];
        const val = p.values[v.id];
        const st = stageFor(v, val);
        const head = el('div', 'pc-sw-readhead');
        head.append(el('span', 'pc-hint', at === n ? (n ? 'Now' : 'At the start') : `After message ${at} (turn ${p.turn})`));
        head.append(el('b', 'pc-sw-bigval', String(val)));
        if (st) {
            const chip = el('span', 'pc-sw-stagechip', st.name || `${st.from}–${st.to}`);
            chip.style.setProperty('--z', zoneColor((v.stages ?? []).indexOf(st)));
            head.append(chip);
        }
        read.append(head);
        const why = h.log.filter(e => e.valueId === v.id && e.index === at);
        if (why.length) read.append(el('div', 'pc-hint', `Changed here by: ${why.map(e => `${e.why} (${e.from} → ${e.to})`).join(', ')}`));
        const sent = sends(v, val);
        const box2 = el('div', `pc-sw-sent${sent.text ? '' : ' pc-sw-sent-none'}`);
        box2.append(el('span', 'pc-label', 'Sent'), el('div', 'pc-sw-senttext', sent.text || sent.none));
        if (sent.dot) box2.append(el('div', 'pc-hint', sent.dot));
        read.append(box2);
    }

    /** What a value sends at a value, in words. */
    function sends(v, val) {
        const mode = v.output ?? 'text';
        const st = stageFor(v, val);
        const dot = v.stageDots && st ? `Its "${st.name || 'stage'}" dot is on: blocks wired to it are switched on.` : '';
        if (mode === 'number' || (v.kind !== 'text' && !(v.stages ?? []).length)) return { text: String(val), dot };
        if (mode === 'stage') return { text: st?.name ?? '', none: 'nothing: no stage, or the stage has no name', dot };
        if (v.kind === 'text') return { text: String(val ?? ''), dot };
        const text = st ? (api.substitute ?? (t => t))(stageText(st, (id) => api.library.get(id)?.content ?? null)).trim() : '';
        return { text, none: st ? 'nothing: this stage has no text' : 'nothing: the value is outside every stage', dot };
    }

    function paintTry() {
        const out = box.querySelector('.pc-sw-tryout');
        if (!out) return;
        out.innerHTML = '';
        const text = ui.tryText.trim();
        if (!text) { out.append(el('span', 'pc-hint', 'Type a message to see what it would change.')); return; }
        const chat = api.chat() ?? [];
        const before = computeState(node, chat);
        // A message you write starts a turn: turn rules fire too.
        const after = computeState(node, [...chat, { is_user: ui.tryWho === 'user', mes: text, extra: {} }]);
        const fresh = after.log.slice(before.log.length);
        const list = el('div', 'pc-sw-trylist');
        let any = false;
        for (const v of node.values) {
            const a = before.byId[v.id], b = after.byId[v.id];
            const why = fresh.filter(e => e.valueId === v.id);
            if (!why.length) continue;
            any = true;
            const row = el('div', 'pc-sw-tryitem');
            const sa = stageFor(v, a), sb = stageFor(v, b);
            row.append(el('b', '', v.name || 'value'), el('span', '', ` ${a} → ${b}`));
            if (sa !== sb) row.append(el('span', 'pc-sw-stagechip', `${sa?.name || 'no stage'} → ${sb?.name || 'no stage'}`));
            row.append(el('span', 'pc-hint', ` (${why.map(e => e.why).join(', ')})`));
            list.append(row);
        }
        out.append(any ? list : el('span', 'pc-hint', ui.tryWho === 'user' ? 'No rule would fire on this message (turn rules do not change anything either).' : 'No rule would fire on this reply.'));
    }

    /* -------------------------------------------------------------- */
    /* small pieces                                                    */
    /* -------------------------------------------------------------- */

    function numIn(value, ph, onInput) {
        const i = el('input', 'text_pole pc-select-num');
        i.type = 'number';
        i.value = value ?? '';
        i.placeholder = ph;
        i.addEventListener('input', () => onInput(i.value));
        return i;
    }

    function segmented(pairs, value, onChange) {
        const s = el('div', 'pc-seg');
        for (const [k, label] of pairs) {
            const b = el('div', `pc-seg-btn${k === value ? ' pc-on' : ''}`, label);
            b.dataset.value = k;
            b.addEventListener('click', () => { if (k !== value) onChange(k); });
            s.append(b);
        }
        return s;
    }

    render();
    return open;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** A value's range for bars: its min and max, or what its stages cover. */
function range(v) {
    const ends = (v.stages ?? []).flatMap(s => [num(s.from, NaN), num(s.to, NaN)]).filter(Number.isFinite);
    let lo = v.min !== '' && v.min != null ? num(v.min) : Math.min(0, ...ends);
    let hi = v.max !== '' && v.max != null ? num(v.max) : Math.max(num(v.start, 10), 10, ...ends);
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
}

/** The chart also stretches to fit where the value actually went. */
function chartRange(v, line) {
    let [lo, hi] = range(v);
    for (const p of line) { const x = num(p.values[v.id]); lo = Math.min(lo, x); hi = Math.max(hi, x); }
    return [lo, hi === lo ? lo + 1 : hi];
}

const pct = (x, lo, hi) => Math.max(0, Math.min(100, ((x - lo) / ((hi - lo) || 1)) * 100));

/** Even stages over the range, highest first (stages are checked top to bottom). */
export function splitStages(v, k) {
    const [lo, hi] = range(v);
    const whole = Number.isInteger(lo) && Number.isInteger(hi);
    const step = (hi - lo + (whole ? 1 : 0)) / k;
    v.stages = Array.from({ length: k }, (_, i) => {
        const from = whole ? Math.round(lo + i * step) : Math.round((lo + i * step) * 100) / 100;
        const to = i === k - 1 ? hi : whole ? Math.round(lo + (i + 1) * step) - 1 : Math.round((lo + (i + 1) * step) * 100) / 100;
        return { id: uid('s'), from, to, name: '', text: '' };
    }).reverse();
    return v.stages;
}

/** A warning when some numbers in the range fall in no stage. */
function coverage(v) {
    const [lo, hi] = range(v);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi - lo > 1000) return '';
    const miss = [];
    for (let x = lo; x <= hi; x++) if (!stageFor(v, x)) miss.push(x);
    if (!miss.length) return '';
    const spans = [];
    for (const x of miss) {
        const last = spans.at(-1);
        if (last && last[1] === x - 1) last[1] = x; else spans.push([x, x]);
    }
    return `⚠ No stage covers ${spans.map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ')}: at ${miss.length === 1 ? 'that value' : 'those values'} nothing is sent.`;
}

/** Ready-made values to start from. */
const PRESETS = [
    ['Energy that drains each turn', () => {
        const v = newStateValue('energy');
        v.start = 10; v.min = 0; v.max = 10;
        v.rules = [
            { id: uid('r'), when: 'turn', op: 'sub', amount: '1' },
            { id: uid('r'), when: 'phrase', terms: 'sleeps, rests, naps', who: 'any', op: 'add', amount: '4' },
        ];
        v.stages = [
            { id: uid('s'), from: 7, to: 10, name: 'fresh', text: '' },
            { id: uid('s'), from: 3, to: 6, name: 'tired', text: '{{char}} is getting tired.' },
            { id: uid('s'), from: 0, to: 2, name: 'exhausted', text: '{{char}} is exhausted and can barely keep going.' },
        ];
        return v;
    }],
    ['Hunger that grows', () => {
        const v = newStateValue('hunger');
        v.start = 0; v.min = 0; v.max = 10;
        v.rules = [
            { id: uid('r'), when: 'every', n: 2, op: 'add', amount: '1' },
            { id: uid('r'), when: 'phrase', terms: 'eats, a meal, dinner, breakfast', who: 'any', op: 'set', amount: '0' },
        ];
        v.stages = [
            { id: uid('s'), from: 8, to: 10, name: 'starving', text: '{{char}} is starving.' },
            { id: uid('s'), from: 4, to: 7, name: 'hungry', text: '{{char}} is hungry.' },
            { id: uid('s'), from: 0, to: 3, name: 'fed', text: '' },
        ];
        return v;
    }],
    ['A mood (a word)', () => {
        const v = newStateValue('mood');
        v.kind = 'text'; v.start = 'calm'; v.min = ''; v.max = '';
        v.rules = [
            { id: uid('r'), when: 'phrase', terms: 'insult, shouts, attacks', who: 'user', op: 'set', amount: 'angry' },
            { id: uid('r'), when: 'phrase', terms: 'apologizes, sorry, hugs', who: 'user', op: 'set', amount: 'calm' },
        ];
        return v;
    }],
    ['An empty number', () => {
        const v = newStateValue('value');
        v.rules = [];
        return v;
    }],
];
