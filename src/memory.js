/**
 * Silly Canvas — Memory blocks.
 *
 * A Memory block is prose the canvas remembers between sends. You type its
 * starting text; Generate blocks wired into it (save wires) write to it.
 *
 * Where the text lives: on the chat's messages, like a State value set by
 * hand. A save made during a send is stored on the message that send answers
 * (the latest message you wrote), under message.extra[MEMORY_KEY][blockId].
 * The text a memory holds is the latest save on a message that still exists.
 *
 * Why there: it is swipe-safe without any bookkeeping.
 *  - A send reads the memory as it was BEFORE the message it answers, so
 *    swiping or regenerating a reply reads the same text again and saves
 *    over its own earlier save instead of adding to it a second time.
 *  - Delete a message and the saves made for it go with it.
 *
 * A save can also be mirrored into a lorebook entry, so SillyTavern's World
 * Info (or a Lorebook block) brings it up by its keywords. The entry always
 * holds the memory's latest text, so writing it again is harmless.
 */

import { NODE_TYPES, WIRE_KINDS, saveWires, activeGraph, safe, ctx } from './state.js?v=0.16.0';

export const MEMORY_KEY = 'promptCanvasMemory';

/**
 * The message a send answers: the latest one you wrote. A swipe or a
 * regenerate answers the same message again. -1 when there is none.
 */
export function anchorIndex(chat = []) {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_system && chat[i].is_user) return i;
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_system) return i;
    return -1;
}

/**
 * What a memory holds, looking only at messages before `before` (all of them
 * when it is not given).
 * @returns {{text: string, index: number}} index: the message it was saved at, -1 = its starting text
 */
export function memoryAt(node, chat = [], before = null) {
    const end = before === null || before === undefined ? chat.length : Math.max(0, before);
    for (let i = end - 1; i >= 0; i--) {
        const saved = chat[i]?.extra?.[MEMORY_KEY]?.[node.id];
        if (saved && typeof saved.text === 'string') return { text: saved.text, index: i };
    }
    return { text: String(node.content ?? ''), index: -1 };
}

/** What a send reads: the memory as it was before the message it answers. */
export function memoryForSend(node, chat = []) {
    return memoryAt(node, chat, anchorIndex(chat));
}

/** Every save kept in the chat, oldest first. */
export function memoryHistory(node, chat = []) {
    const out = [];
    chat.forEach((m, i) => {
        const saved = m?.extra?.[MEMORY_KEY]?.[node.id];
        if (saved && typeof saved.text === 'string') out.push({ index: i, text: saved.text, at: saved.at ?? null, by: saved.by ?? null });
    });
    return out;
}

/** Paragraphs: text split on blank lines. */
const paragraphs = (t) => String(t ?? '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);

/** A saved answer landing on what a memory held. */
export function combine(node, old, incoming) {
    const add = String(incoming ?? '').trim();
    if (!add) return String(old ?? '');
    switch (node.saveMode) {
        case 'append': return [String(old ?? '').trim(), add].filter(Boolean).join('\n\n');
        case 'keep': {
            const n = Math.max(1, Math.round(Number(node.keep) || 5));
            return [...paragraphs(old), ...paragraphs(add)].slice(-n).join('\n\n');
        }
        case 'replace':
        default: return add;
    }
}

/**
 * The saves one send makes, worked out from the Generate answers. Several
 * answers into one memory land in canvas order (top to bottom).
 *
 * @param {object} graph
 * @param {Record<string,string>} results  Generate block id -> answer
 * @param {object} live   gatherContext() (chat, substitute...)
 * @param {{applySelect?: Function, wireHolds?: Function}} tools  the wire filter and condition, passed in to keep this file free of the compiler
 * @returns {Array<{node: object, text: string, from: string[]}>}
 */
export function plannedSaves(graph, results, live, { applySelect = (m) => m, wireHolds = () => true, decisions = {}, deciderText = () => '' } = {}) {
    graph = activeGraph(graph);
    const chat = live?.chat ?? [];
    const byMemory = new Map();
    const wires = saveWires(graph)
        .filter(w => graph.nodes[w.to]?.type === NODE_TYPES.MEMORY && graph.nodes[w.to].enabled !== false)
        .sort((a, b) => (graph.nodes[a.from]?.y ?? 0) - (graph.nodes[b.from]?.y ?? 0));
    for (const w of wires) {
        const src = graph.nodes[w.from];
        let text;
        if (src?.type === NODE_TYPES.DECIDER) {
            text = deciderSave(src, w, decisions?.[src.id], live, deciderText);
            if (!text) continue;
        } else {
            const answer = results?.[w.from];
            if (typeof answer !== 'string' || !answer.trim()) continue;
            const picked = applySelect([{ role: 'assistant', content: answer }], w.select, live);
            text = picked.map(m => m.content).filter(Boolean).join('\n\n').trim();
        }
        if (!text) continue;
        if (w.condition && !wireHolds(w, live, text)) continue;
        const list = byMemory.get(w.to) ?? [];
        list.push({ text, from: src?.title || 'Generate' });
        byMemory.set(w.to, list);
    }
    const out = [];
    for (const [id, list] of byMemory) {
        const node = graph.nodes[id];
        let text = memoryForSend(node, chat).text;
        for (const x of list) text = combine(node, text, x.text);
        out.push({ node, text, from: list.map(x => x.from) });
    }
    return out;
}

/** What a Decider's save wire can save. */
export const DECIDER_SAVES = {
    name: 'the name of the output',
    matched: 'the words that matched',
    input: 'the text the Decider read',
    text: 'my own text',
};

/**
 * What a Decider's save wire writes, when the output it leaves from was
 * chosen; '' when it was not. In your own text, {{result}} is the output's
 * name, {{matched}} the words that matched, {{input}} the text it read, and
 * SillyTavern's macros ({{char}}, {{user}}, {{time}}\u2026) work as usual.
 */
export function deciderSave(dec, wire, decision, live, deciderText = () => '') {
    if (!decision) return '';
    const chosen = decision.keys ?? [decision.key];
    if (!chosen.includes(wire.port)) return '';
    const key = [...(dec.keys ?? []), dec.fallback].find(k => k?.id === wire.port);
    const name = key?.name || decision.name || 'output';
    const matched = (decision.matched ?? []).join(', ');
    switch (wire.save ?? 'name') {
        case 'matched': return matched || name;
        case 'input': return String(deciderText(dec) ?? '').trim();
        case 'text': {
            let t = String(wire.saveText ?? '');
            if (!t.trim()) return name;
            t = t.replace(/\{\{result\}\}/gi, name).replace(/\{\{matched\}\}/gi, matched || name);
            if (/\{\{input\}\}/i.test(t)) t = t.replace(/\{\{input\}\}/gi, String(deciderText(dec) ?? '').trim());
            const sub = live?.substitute;
            return String(typeof sub === 'function' ? sub(t) : t).trim();
        }
        case 'name':
        default: return name;
    }
}

/**
 * Put saves on the chat: on the message this send answers. Replaces this
 * send's earlier save of the same memory (a swipe or regenerate), never adds
 * a second one.
 * @returns {number} how many were written
 */
export function writeSaves(saves, chat = ctx().chat ?? []) {
    const at = anchorIndex(chat);
    if (at < 0 || !saves.length) return 0;
    const m = chat[at];
    m.extra ??= {};
    m.extra[MEMORY_KEY] ??= {};
    for (const s of saves) m.extra[MEMORY_KEY][s.node.id] = { text: s.text, at: Date.now(), by: s.from?.join(', ') || undefined };
    return saves.length;
}

/** Set a memory by hand, from now on. Kept on the latest message. */
export function setMemoryNow(node, text, chat = ctx().chat ?? []) {
    let i = chat.length - 1;
    while (i >= 0 && chat[i]?.is_system) i--;
    if (i < 0) return false;
    chat[i].extra ??= {};
    chat[i].extra[MEMORY_KEY] ??= {};
    chat[i].extra[MEMORY_KEY][node.id] = { text: String(text ?? ''), at: Date.now(), by: 'you' };
    return true;
}

/* ------------------------------------------------------------------ */
/* lorebook mirror                                                     */
/* ------------------------------------------------------------------ */

let worldInfoApi = null;
/** For tests, or when the world-info module lives elsewhere. */
export function setWorldInfoApi(api) { worldInfoApi = api; }

async function wi() {
    if (worldInfoApi) return worldInfoApi;
    try { return await import('/scripts/world-info.js'); } catch { return null; }
}

/** The lorebooks there are, for picking one. */
export async function lorebookNames() {
    const api = await wi();
    const names = safe(() => api?.world_names);
    return Array.isArray(names) ? [...names].sort((a, b) => a.localeCompare(b)) : [];
}

const splitKeys = (s) => String(s ?? '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/**
 * Write a memory's text into its lorebook entry: find the entry it wrote
 * before (or one with the same title), or make one, and set its text.
 * @returns {Promise<{ok: boolean, reason?: string, uid?: number}>}
 */
export async function mirrorToLorebook(node, text) {
    const lore = node.lore ?? {};
    if (!lore.on) return { ok: false, reason: 'off' };
    const book = String(lore.book ?? '').trim();
    if (!book) return { ok: false, reason: 'Choose a lorebook to keep this memory in.' };
    const api = await wi();
    if (!api?.loadWorldInfo || !api?.saveWorldInfo || !api?.createWorldInfoEntry) return { ok: false, reason: 'SillyTavern’s World Info could not be reached.' };
    const data = await api.loadWorldInfo(book);
    if (!data?.entries) return { ok: false, reason: `The lorebook "${book}" could not be opened.` };
    const title = String(lore.title || node.title || 'Memory').trim();
    // The entry it wrote last time (by its number, if it still has this
    // title or no title), or else one with the same title, or a new one.
    let entry = lore.uid !== undefined && lore.uidBook === book ? data.entries[lore.uid] : null;
    if (entry && entry.comment && entry.comment !== title && entry.comment !== lore.lastTitle) entry = null;
    entry ??= Object.values(data.entries).find(e => e?.comment === title);
    if (!entry) entry = api.createWorldInfoEntry(book, data);
    if (!entry) return { ok: false, reason: `Could not add an entry to "${book}".` };
    entry.comment = title;
    entry.content = String(text ?? '');
    entry.key = splitKeys(lore.keys);
    entry.constant = !!lore.constant;
    entry.disable = false;
    lore.lastTitle = title;
    lore.uid = entry.uid;
    lore.uidBook = book;
    await api.saveWorldInfo(book, data, true);
    return { ok: true, uid: entry.uid };
}

/** The blocks on a canvas that are memories. */
export function memoryNodes(graph) {
    return Object.values(graph?.nodes ?? {}).filter(n => n.type === NODE_TYPES.MEMORY);
}

export { WIRE_KINDS };
