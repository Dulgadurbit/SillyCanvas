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

import { evaluate, holds } from './expr.js?v=0.12.0';

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
 * @returns {{byId: Record<string, number|string>, byName: Record<string, number|string>, turn: number, log: Array}}
 */
export function computeState(node, chat = []) {
    const values = (node.values ?? []).filter(v => v && v.id);
    const cur = {};
    for (const v of values) cur[v.id] = clampValue(v, startOf(v));
    const log = [];
    const varsOf = (turn, index) => {
        const o = { turn, messages: index };
        for (const v of values) if (v.name) o[v.name] = cur[v.id];
        return o;
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
                if (r.when === 'turn' || (r.when === 'every' && turn % Math.max(1, num(r.n, 1)) === 0)) {
                    cur[v.id] = clampValue(v, act(v, cur[v.id], r, varsOf(turn, index)));
                } else if (r.when === 'formula' && String(r.formula ?? '').trim() && holds(r.formula, varsOf(turn, index))) {
                    cur[v.id] = clampValue(v, act(v, cur[v.id], r, varsOf(turn, index)));
                }
            }
        }
        for (const v of values) for (const r of v.rules ?? []) {
            if (r.when !== 'phrase') continue;
            if ((r.who ?? 'any') !== 'any' && r.who !== who) continue;
            const hit = mentions(m.mes, r.terms, { negation: r.negation !== false });
            if (!hit) continue;
            cur[v.id] = clampValue(v, act(v, cur[v.id], r, varsOf(turn, index)));
            log.push({ index, valueId: v.id, why: `"${hit}"` });
        }
        const set = m.extra?.[NUDGE_KEY]?.[node.id];
        if (set) for (const v of values) if (set[v.id] !== undefined) cur[v.id] = clampValue(v, set[v.id]);
    }
    const byName = {};
    for (const v of values) if (v.name) byName[v.name] = cur[v.id];
    return { byId: cur, byName, turn, log };
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

/** What one value's output sends: its stage's text, its number, or its stage name. */
export function valueOutput(v, value, sub = (t) => t) {
    const mode = v.output ?? 'text';
    if (mode === 'number') return String(value);
    const st = stageFor(v, value);
    if (mode === 'stage') return st?.name ? String(st.name) : '';
    if (v.kind === 'text') return String(value ?? '');
    if (!(v.stages ?? []).length) return String(value);
    return st ? sub(String(st.text ?? '')).trim() : '';
}
