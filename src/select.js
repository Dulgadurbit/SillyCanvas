/**
 * "Send what?" — a filter on a wire that decides exactly what travels along it.
 *
 * It works on the list of messages the upstream block produced. Chat messages
 * carry their SillyTavern message number (`__idx`) and speaker (`__speaker`),
 * put there by the History block, so a filter can pick "the last 3 from the
 * user" or "#23 and #25" out of a wall of story.
 *
 * Order, always the same so the result is predictable:
 *   1. message numbers   2. who   3. skip newest   4. how many
 *   5. text: extract between tags, strip thinking, keep paragraphs
 *   6. how it arrives: as messages, or joined into one text
 *
 * A wire with no filter (or an all-defaults one) carries everything, exactly
 * as before.
 */

export const DEFAULT_SELECT = Object.freeze({
    count: 'all',        // 'all' | 'last' | 'first'
    n: 5,
    who: 'any',          // 'any' | 'user' | 'char'
    numbers: '',         // "23, 25, 30-35"
    skip: 0,             // leave out the newest N
    between: '',         // tag name: keep only <tag>…</tag>
    stripThinking: false,
    keep: 'all',         // 'all' | 'firstPara' | 'lastPara'
    paras: 1,
    join: false,         // true: one text instead of separate messages
    labels: false,       // with join: prefix each part with the speaker's name
});

const num = (v, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : d;
};

/** "23, 25, 30-35" -> Set{23,25,30..35}. Junk is ignored. Capped so a typo like 1-99999999 stays cheap. */
export function parseNumbers(text) {
    const out = new Set();
    for (const part of String(text ?? '').split(/[,\s;]+/)) {
        if (!part) continue;
        const r = /^#?(\d+)\s*-\s*#?(\d+)$/.exec(part);
        if (r) {
            let a = Number(r[1]), b = Number(r[2]);
            if (a > b) [a, b] = [b, a];
            for (let i = a; i <= b && i - a < 5000; i++) out.add(i);
            continue;
        }
        const one = /^#?(\d+)$/.exec(part);
        if (one) out.add(Number(one[1]));
    }
    return out;
}

/** Whether a filter changes anything at all. */
export function isActive(sel) {
    if (!sel || typeof sel !== 'object') return false;
    const s = { ...DEFAULT_SELECT, ...sel };
    return s.count !== 'all' || s.who !== 'any' || !!String(s.numbers).trim() || num(s.skip, 0) > 0
        || !!String(s.between).trim() || !!s.stripThinking || s.keep !== 'all' || !!s.join;
}

const isUser = (m) => m.role === 'user';
const isChar = (m) => m.role === 'assistant';

const THINK_RE = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>\s*/gi;

function tagName(raw) {
    return String(raw ?? '').trim().replace(/^<\/?|>$/g, '').trim();
}

function extractBetween(text, tag) {
    const t = tagName(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!t) return text;
    const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'gi');
    const found = [...String(text).matchAll(re)].map(m => m[1].trim()).filter(Boolean);
    return found.join('\n\n');
}

function keepParagraphs(text, mode, n) {
    if (mode === 'all') return text;
    const paras = String(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const k = Math.max(1, num(n, 1));
    return (mode === 'firstPara' ? paras.slice(0, k) : paras.slice(-k)).join('\n\n');
}

function speakerOf(m, live) {
    if (m.__speaker) return m.__speaker;
    if (isUser(m)) return live?.name1 || 'User';
    if (isChar(m)) return live?.name2 || 'Character';
    return '';
}

/**
 * Apply a filter to the messages crossing a wire.
 * @param {Array<{role:string, content:string}>} messages
 * @param {object|null} sel
 * @param {object} [live]  gathered context, for speaker names
 * @returns {Array}
 */
export function applySelect(messages, sel, live = null) {
    if (!isActive(sel)) return messages;
    const s = { ...DEFAULT_SELECT, ...sel };
    let list = messages.slice();

    const numbers = parseNumbers(s.numbers);
    if (numbers.size) list = list.filter(m => Number.isInteger(m.__idx) && numbers.has(m.__idx));

    if (s.who === 'user') list = list.filter(isUser);
    else if (s.who === 'char') list = list.filter(isChar);

    const skip = Math.max(0, num(s.skip, 0));
    if (skip) list = list.slice(0, Math.max(0, list.length - skip));

    const n = Math.max(0, num(s.n, 5));
    if (s.count === 'last') list = n ? list.slice(-n) : [];
    else if (s.count === 'first') list = list.slice(0, n);

    list = list.map(m => {
        let text = String(m.content ?? '');
        if (s.stripThinking) text = text.replace(THINK_RE, '');
        if (tagName(s.between)) text = extractBetween(text, s.between);
        text = keepParagraphs(text, s.keep, s.paras).trim();
        return { ...m, content: text };
    }).filter(m => m.content);

    if (s.join && list.length) {
        const parts = list.map(m => {
            const who = s.labels ? speakerOf(m, live) : '';
            return who ? `${who}: ${m.content}` : m.content;
        });
        // One message, placed where the first one was.
        const first = list[0];
        return [{ role: first.role === 'assistant' || first.role === 'user' ? 'system' : (first.role || 'system'), content: parts.join('\n\n'), ...(first.__y !== undefined ? { __y: first.__y } : {}) }];
    }
    return list;
}

/** A few words for the wire label: "last 5 · user · <plan>". Empty when the filter does nothing. */
export function selectLabel(sel) {
    if (!isActive(sel)) return '';
    const s = { ...DEFAULT_SELECT, ...sel };
    const bits = [];
    const nums = String(s.numbers).trim();
    if (nums) bits.push(`#${nums.replace(/\s+/g, '')}`);
    if (s.count === 'last') bits.push(`last ${num(s.n, 5)}`);
    if (s.count === 'first') bits.push(`first ${num(s.n, 5)}`);
    if (s.who === 'user') bits.push('user');
    if (s.who === 'char') bits.push('char');
    if (num(s.skip, 0) > 0) bits.push(`skip ${num(s.skip, 0)}`);
    if (tagName(s.between)) bits.push(`<${tagName(s.between)}>`);
    if (s.stripThinking) bits.push('no thinking');
    if (s.keep === 'firstPara') bits.push(`first ${num(s.paras, 1)} ¶`);
    if (s.keep === 'lastPara') bits.push(`last ${num(s.paras, 1)} ¶`);
    if (s.join) bits.push(s.labels ? 'as text, named' : 'as text');
    return bits.join(' · ');
}
