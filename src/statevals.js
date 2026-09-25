/**
 * State block: values that change as the chat goes on (energy, hunger, mana,
 * a level, a mood...), turned into words by a stage table.
 *
 * Swipe-safe by design: nothing is counted up and saved. Every time, the
 * values are worked out again by replaying the rules over the chat as it is
 * now, so a swipe, a regenerate or a deleted message can never count a turn
 * twice. The only thing saved is a value you set by hand, and it is saved on
 * the message it was set at, so it goes if that message goes.
 */

import { evaluate, holds } from './expr.js?v=0.15.0';

/** Where hand-set values live on a message: message.extra[NUDGE_KEY][blockId][valueId] = value */
export const NUDGE_KEY = 'promptCanvasState';

const NEGATION = /\b(not|never|no|without|didn['’]?t|doesn['’]?t|don['’]?t|won['’]?t|can['’]?t|cannot|isn['’]?t|wasn['’]?t|refuses?|refused|skips?|skipped)\b[^.!?\n]{0,24}$/i;

/**
 * Whether any of the words or phrases is in a text. By default a match
 * right after "didn't", "refuses", "never"... does not count.
 */
export function mentions(text, terms, { negation = true } = {}) {
    const hay = String(text ?? '');
    const low = hay.toLowerCase();
    for (const raw of String(terms ?? '').split(/[\n,]/)) {
        const t = raw.trim().toLowerCase();
        if (!t) continue;
        const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
        let m;
        while ((m = re.exec(low))) {
            const at = m.index + m[1].length;
            if (!negation || !NEGATION.test(low.slice(Math.max(0, at - 40), at))) return t;
            re.lastIndex = at + 1;
        }
    }
    return null;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function startOf(v) {
    if (v.kind === 'text') return String(v.start ?? '');
    return num(v.start, 0);
}

function clampValue(v, x) {
    if (v.kind === 'text') return String(x ?? '');
    let n = num(x, 0);
    if (v.min !== '' && v.min !== null && v.min !== undefined && Number.isFinite(Number(v.min))) n = Math.max(Number(v.min), n);
    if (v.max !== '' && v.max !== null && v.max !== undefined && Number.isFinite(Number(v.max))) n = Math.min(Number(v.max), n);
    return Math.round(n * 1000) / 1000;
}

/** Apply one rule's action to a value. */
function act(v, current, rule, vars) {
    const amount = rule.amount === undefined || rule.amount === '' ? (rule.op === 'set' ? current : 1) : rule.amount;
    const x = v.kind === 'text' && rule.op === 'set' && !/[()+\-*/<>=!?]/.test(String(amount))
        ? String(amount)
        : evaluate(String(amount), vars, 0);
    switch (rule.op) {
        case 'add': return num(current) + num(x);
        case 'sub': return num(current) - num(x);
        case 'mul': return num(current) * num(x);
        case 'reset': return startOf(v);
        case 'set':
        default: return x;
    }
}

/**
 * Replay one State block over the chat.
 * @param {object} node   the State block
 * @param {Array} chat    SillyTavern's chat array
 * @param {{timeline?: boolean}} [opts]  timeline: also keep every value after each message, for charts
 * @returns {{byId: Record<string, number|string>, byName: Record<string, number|string>, turn: number, log: Array, timeline?: Array}}
 *   log: one entry per change: {index, turn, valueId, ruleId, why, from, to}; index is the message number (1 = first)
 */
export function computeState(node, chat = [], { timeline = false } = {}) {
    const values = (node.values ?? []).filter(v => v && v.id);
    const cur = {};
    for (const v of values) cur[v.id] = clampValue(v, startOf(v));
    const log = [];
    const line = timeline ? [{ index: 0, turn: 0, values: { ...cur } }] : null;
    const varsOf = (turn, index) => {
        const o = { turn, messages: index };
        for (const v of values) if (v.name) o[v.name] = cur[v.id];
        return o;
    };
    const apply = (v, r, turn, index, why) => {
        const from = cur[v.id];
        cur[v.id] = clampValue(v, act(v, from, r, varsOf(turn, index)));
        log.push({ index, turn, valueId: v.id, ruleId: r.id ?? null, why, from, to: cur[v.id] });
    };
    let turn = 0;
    let index = 0;
    const list = (chat ?? []).filter(m => m && !m.is_system);
    for (const m of list) {
        index++;
        const who = m.is_user ? 'user' : 'char';
        if (m.is_user) {
            turn++;
            for (const v of values) for (const r of v.rules ?? []) {
                if (r.when === 'turn') apply(v, r, turn, index, 'every turn');
                else if (r.when === 'every' && turn % Math.max(1, num(r.n, 1)) === 0) apply(v, r, turn, index, `every ${Math.max(1, num(r.n, 1))} turns`);
                else if (r.when === 'formula' && String(r.formula ?? '').trim() && holds(r.formula, varsOf(turn, index))) apply(v, r, turn, index, r.formula);
            }
        }
        for (const v of values) for (const r of v.rules ?? []) {
            if (r.when !== 'phrase') continue;
            if ((r.who ?? 'any') !== 'any' && r.who !== who) continue;
            const hit = mentions(m.mes, r.terms, { negation: r.negation !== false });
            if (!hit) continue;
            apply(v, r, turn, index, `"${hit}"`);
        }
        const set = m.extra?.[NUDGE_KEY]?.[node.id];
        if (set) for (const v of values) if (set[v.id] !== undefined) {
            const from = cur[v.id];
            cur[v.id] = clampValue(v, set[v.id]);
            log.push({ index, turn, valueId: v.id, ruleId: null, why: 'set by hand', from, to: cur[v.id], byHand: true });
        }
        if (line) line.push({ index, turn, values: { ...cur } });
    }
    const byName = {};
    for (const v of values) if (v.name) byName[v.name] = cur[v.id];
    return { byId: cur, byName, turn, log, ...(line ? { timeline: line } : {}) };
}

/** The stage a number falls in, or null. Stages are checked top to bottom. */
export function stageFor(v, value) {
    if (v?.kind === 'text') return null;
    const n = num(value, NaN);
    for (const s of v?.stages ?? []) {
        const lo = s.from === '' || s.from === undefined || s.from === null ? -Infinity : num(s.from, -Infinity);
        const hi = s.to === '' || s.to === undefined || s.to === null ? Infinity : num(s.to, Infinity);
        if (n >= lo && n <= hi) return s;
    }
    return null;
}

/**
 * What a stage sends: its own text, or the library prompt it is linked to.
 * @param {(id: string) => string|null} [lookup]  a library prompt's text by id
 */
export function stageText(stage, lookup = () => null) {
    if (!stage) return '';
    if (stage.source === 'prompt' && stage.promptId) return String(lookup(stage.promptId) ?? '');
    return String(stage.text ?? '');
}

/** What one value's output sends: its stage's text, its number, or its stage name. */
export function valueOutput(v, value, sub = (t) => t, lookup = () => null) {
    const mode = v.output ?? 'text';
    if (mode === 'number') return String(value);
    const st = stageFor(v, value);
    if (mode === 'stage') return st?.name ? String(st.name) : '';
    if (v.kind === 'text') return String(value ?? '');
    if (!(v.stages ?? []).length) return String(value);
    return st ? sub(stageText(st, lookup)).trim() : '';
}

/*
 * A value can give each of its stages its own output dot. Its port id is
 * "<value id>:<stage id>". The dot is "on" while the value is in that stage;
 * wired with Activate (the default) it switches a block on for that stage
 * only, so any prompt, or a whole group of blocks, can be a stage.
 */
export const STAGE_PORT_SEP = ':';

export function stagePortId(v, stage) {
    return `${v.id}${STAGE_PORT_SEP}${stage.id}`;
}

/** {valueId, stageId} for a port id; stageId is null for the value's own dot. */
export function parseStatePort(port) {
    const s = String(port ?? '');
    const at = s.indexOf(STAGE_PORT_SEP);
    return at < 0 ? { valueId: s, stageId: null } : { valueId: s.slice(0, at), stageId: s.slice(at + 1) };
}

let stageSeq = 0;
/** Give every stage an id, so it can have a dot and be wired. */
export function ensureStageIds(v) {
    for (const st of v?.stages ?? []) st.id ??= `s${Date.now().toString(36)}${(++stageSeq).toString(36)}`;
    return v;
}
