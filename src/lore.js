/**
 * Lorebook block: reads SillyTavern lorebooks (World Info) directly, so the
 * canvas decides which entries are sent and where they go.
 *
 * Pure functions only: the loading happens in gatherContext() (compile.js),
 * which puts everything these need into `live.lore`:
 *   sources  {chat:[], character:[], persona:[], global:[]}  book names
 *   books    {name: Entry[]}
 *   activated  [{world, uid}] | null  what SillyTavern itself activated on a
 *              real send; null in a preview, when we estimate instead
 *   defaults {caseSensitive, wholeWords, depth}
 */

/** SillyTavern's entry positions, in words. */
export const LORE_POSITIONS = [
    ['any', 'any position'],
    ['0', 'before character'],
    ['1', 'after character'],
    ['2', 'top of Author’s Note'],
    ['3', 'bottom of Author’s Note'],
    ['4', '@ depth'],
    ['5', 'top of example messages'],
    ['6', 'bottom of example messages'],
    ['7', 'outlet'],
];

/** One lorebook entry, trimmed to what the block needs. */
export function toEntry(e, book) {
    const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean);
    return {
        book,
        uid: e.uid,
        title: String(e.comment ?? '').trim(),
        content: String(e.content ?? ''),
        keys: list(e.key),
        secondary: list(e.keysecondary),
        selective: !!e.selective,
        logic: Number(e.selectiveLogic ?? 0),
        constant: !!e.constant,
        disabled: !!e.disable,
        order: Number(e.order ?? 100),
        position: Number(e.position ?? 0),
        group: String(e.group ?? '').trim(),
        caseSensitive: e.caseSensitive ?? null,
        wholeWords: e.matchWholeWords ?? null,
        memory: e.stmemorybooks === true,
        sceneEnd: Number.isFinite(Number(e.STMB_end)) ? Number(e.STMB_end) : null,
    };
}

/** A key written as /pattern/flags is a regular expression, as in SillyTavern. */
function keyRegex(key) {
    const m = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
    if (!m) return null;
    try { return new RegExp(m[1], m[2]); } catch { return null; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a key is found in a text, or -1. Follows SillyTavern's rules:
 * regex keys, case sensitivity and whole words, per entry or from the defaults.
 */
export function findKey(text, key, entry, defaults = {}) {
    const re = keyRegex(key);
    if (re) {
        const m = re.exec(text);
        return m ? m.index : -1;
    }
    const cs = entry.caseSensitive ?? !!defaults.caseSensitive;
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? key : key.toLowerCase();
    if (!needle) return -1;
    const whole = entry.wholeWords ?? !!defaults.wholeWords;
    if (whole && !/\s/.test(needle)) {
        const r = new RegExp(`(?:^|\\W)(${escapeRe(needle)})(?:$|\\W)`, 'g');
        let last = -1, m;
        while ((m = r.exec(hay))) { last = m.index; r.lastIndex = m.index + 1; }
        return last;
    }
    return hay.lastIndexOf(needle);
}

/**
 * Whether an entry's keys fire on a text, and where (the latest match, so
 * "most recent" ordering can use it).
 * @returns {{hit:boolean, at:number, key:string|null}}
 */
export function matchEntry(entry, text, defaults = {}) {
    let best = { hit: false, at: -1, key: null };
    for (const k of entry.keys) {
        const at = findKey(text, k, entry, defaults);
        if (at >= 0 && at >= best.at) best = { hit: true, at, key: k };
    }
    if (!best.hit) return best;
    if (!entry.selective || !entry.secondary.length) return best;
    const found = entry.secondary.map(k => findKey(text, k, entry, defaults) >= 0);
    const ok = {
        0: found.some(Boolean),        // AND ANY
        1: !found.every(Boolean),      // NOT ALL
        2: !found.some(Boolean),       // NOT ANY
        3: found.every(Boolean),       // AND ALL
    }[entry.logic] ?? found.some(Boolean);
    return ok ? best : { hit: false, at: -1, key: null };
}

/** The lorebooks a block reads, in order, without repeats. */
export function blockBooks(node, lore) {
    const s = node.sources ?? {};
    const src = lore?.sources ?? {};
    const names = [];
    if (s.chat) names.push(...(src.chat ?? []));
    if (s.character) names.push(...(src.character ?? []));
    if (s.persona) names.push(...(src.persona ?? []));
    if (s.global) names.push(...(src.global ?? []));
    names.push(...(node.books ?? []));
    return [...new Set(names.filter(Boolean))];
}

/** The last N chat messages as one text, newest last. */
function chatText(live, n) {
    const chat = (live.chat ?? []).filter(m => !m.is_system);
    return chat.slice(-Math.max(1, n)).map(m => String(m.mes ?? '')).join('\n');
}

/**
 * Pick the entries a Lorebook block sends.
 * @param {object} node   the block
 * @param {object} live   gathered context (live.lore, live.chat)
 * @param {string} incoming  the text wired into the block
 * @returns {{entries: Array<object>, estimated: boolean, books: string[], missing: string[]}}
 */
export function selectLore(node, live, incoming = '') {
    const lore = live.lore ?? { sources: {}, books: {}, activated: null, defaults: {} };
    const defaults = lore.defaults ?? {};
    const books = blockBooks(node, lore);
    const missing = books.filter(b => !lore.books?.[b]);
    let pool = books.flatMap(b => lore.books?.[b] ?? []);
    if (!node.includeDisabled) pool = pool.filter(e => !e.disabled);
    pool = pool.filter(e => e.content.trim());

    // filters
    const titles = String(node.titleFilter ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (titles.length) pool = pool.filter(e => titles.some(t => e.title.toLowerCase().includes(t)));
    const group = String(node.group ?? '').trim().toLowerCase();
    if (group) pool = pool.filter(e => e.group.toLowerCase().split(',').map(s => s.trim()).includes(group));
    if (node.position && node.position !== 'any') pool = pool.filter(e => String(e.position) === String(node.position));
    if (node.memoryOnly) {
        pool = pool.filter(e => e.memory);
        const recent = Math.max(0, Number(node.skipRecent) || 0);
        if (recent) {
            const cutoff = (live.chat?.length ?? 0) - recent;
            pool = pool.filter(e => e.sceneEnd === null || e.sceneEnd < cutoff);
        }
    }

    // which ones fire
    let estimated = false;
    let picked = [];
    const mode = node.mode ?? 'st';
    const scanWith = (text, withConstant) => {
        for (const e of pool) {
            if (e.constant && withConstant) { picked.push({ ...e, why: 'constant', at: Infinity }); continue; }
            const m = matchEntry(e, text, defaults);
            if (m.hit) picked.push({ ...e, why: `key "${m.key}"`, at: m.at });
        }
    };
    if (mode === 'all') picked = pool.map(e => ({ ...e, why: 'every entry' }));
    else if (mode === 'constant') picked = pool.filter(e => e.constant).map(e => ({ ...e, why: 'constant' }));
    else if (mode === 'picked') {
        const want = new Set(node.picked ?? []);
        picked = pool.filter(e => want.has(`${e.book}|${e.uid}`)).map(e => ({ ...e, why: 'picked by you' }));
    } else if (mode === 'scan') {
        const text = node.scanFrom === 'chat' ? chatText(live, Number(node.scanDepth) || 4) : String(incoming ?? '');
        scanWith(text, node.includeConstant !== false);
    } else {
        // As SillyTavern would. On a real send it tells us what it activated;
        // in a preview we estimate: constant entries plus keys in the last
        // messages it scans.
        if (Array.isArray(lore.activated)) {
            const on = new Set(lore.activated.map(a => `${a.world}|${a.uid}`));
            picked = pool.filter(e => on.has(`${e.book}|${e.uid}`)).map(e => ({ ...e, why: 'activated by SillyTavern' }));
        } else {
            estimated = true;
            scanWith(chatText(live, Number(defaults.depth) || 2), true);
        }
    }

    // order
    const order = node.order ?? 'order';
    if (order === 'alpha') picked.sort((a, b) => a.title.localeCompare(b.title));
    else if (order === 'recent') picked.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    else picked.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));

    // limits: keep the most important end of the list (the end, where the
    // highest order and the most recent sit).
    const max = Math.max(0, Number(node.maxEntries) || 0);
    if (max && picked.length > max) picked = picked.slice(-max);
    const budget = Math.max(0, Number(node.tokenBudget) || 0);
    if (budget) {
        const kept = [];
        let used = 0;
        for (const e of [...picked].reverse()) {
            const cost = Math.ceil(e.content.length / 4);
            if (used + cost > budget) continue;
            used += cost;
            kept.unshift(e);
        }
        picked = kept;
    }
    return { entries: picked, estimated, books, missing };
}

/** The messages a Lorebook block sends, from the entries it picked. */
export function loreMessages(node, live, picked) {
    const sub = live.substitute ?? (t => t);
    const role = node.role || 'system';
    const text = (e) => {
        const body = sub(e.content).trim();
        return node.titles && e.title ? `${e.title}\n${body}` : body;
    };
    const parts = picked.map(text).filter(Boolean);
    if (!parts.length) return [];
    const prefix = sub(node.prefix ?? '').trim();
    const suffix = sub(node.suffix ?? '').trim();
    if (node.separate) {
        const msgs = parts.map(content => ({ role, content }));
        if (prefix) msgs[0] = { ...msgs[0], content: `${prefix}\n\n${msgs[0].content}` };
        if (suffix) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: `${msgs[msgs.length - 1].content}\n\n${suffix}` };
        return msgs;
    }
    return [{ role, content: [prefix, parts.join('\n\n'), suffix].filter(Boolean).join('\n\n') }];
}

/**
 * Take a block's entries out of SillyTavern's own World Info text, so the
 * same lore is not sent twice when World Info is also on the canvas.
 */
export function stripFromWorldInfo(text, entries, sub = (t) => t) {
    let out = String(text ?? '');
    for (const e of entries) {
        const body = sub(e.content).trim();
        if (body && out.includes(body)) out = out.split(body).join('');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}
