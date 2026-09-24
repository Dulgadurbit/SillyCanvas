/**
 * Silly Canvas — the compiler.
 *
 * A graph is not executed. It is compiled into a plan, and the plan is what
 * runs. That separation is the whole point: a plan is inspectable before a
 * single token is spent, and a graph that compiles to nothing fails loudly on
 * the canvas instead of quietly sending a broken prompt.
 *
 * Two node kinds decide the shape of a run:
 *
 *   Generate   a model call sitting in the middle of the graph. Everything
 *              wired into it is the prompt for that call. Its answer is what
 *              flows on to whatever sits below it. It is a barrier: the blocks
 *              feeding it never reach the final prompt, only its answer does.
 *   Output     the final send. Everything wired here becomes the real reply.
 *
 * So a graph with two Generate blocks is three calls, in canvas order, and you
 * can read that off the picture without tracing a single wire.
 *
 * Reading order is vertical. Where two blocks both feed the same target, the
 * one higher on the canvas goes in first. That is the rule, everywhere, with
 * no exceptions, because a graph you have to trace to predict is not a tool.
 */

import { ctx, safe, NODE_TYPES, WIRE_KINDS, wiresInto, wiresOutOf, outputNode, togetherGroup, groupWires, deciderKeys, settings } from './state.js?v=0.11.0';
import { stPrompt, MARKER_SOURCES } from './library.js?v=0.11.0';
import { applySelect } from './select.js?v=0.11.0';
import { toEntry, selectLore, loreMessages, blockBooks, stripFromWorldInfo } from './lore.js?v=0.11.0';

/* ------------------------------------------------------------------ */
/* live context                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything the compiler may need to resolve a block, gathered once.
 * Anything that throws resolves to null and is reported as unresolved rather
 * than silently becoming an empty string.
 */
export async function gatherContext({ dryRun = false } = {}) {
    const c = ctx();
    const card = safe(() => c.getCharacterCardFields()) ?? {};
    const chat = safe(() => Array.isArray(c.chat) ? c.chat : []) ?? [];

    listenForActivations(c);
    const scanStarted = Date.now();
    let wiBefore = null, wiAfter = null;
    try {
        const wi = await c.getWorldInfoPrompt(
            chat.map(m => `${m.name}: ${m.mes}`).reverse(),
            Number(c.maxContext) || 4096,
            !!dryRun,
        );
        wiBefore = wi?.worldInfoBefore ?? '';
        wiAfter = wi?.worldInfoAfter ?? '';
    } catch {
        wiBefore = null;
        wiAfter = null;
    }

    // On a real send SillyTavern reports what it activated; a preview estimates.
    const activated = !dryRun && lastActivated && lastActivated.at >= scanStarted ? lastActivated.entries : null;
    const lore = await loadLore(c, activated);

    return {
        card,
        chat,
        lore,
        name1: c.name1,
        name2: c.name2,
        worldInfo: { before: wiBefore, after: wiAfter },
        extensionPrompts: safe(() => c.extensionPrompts) ?? {},
        model: safe(() => c.getChatCompletionModel()) ?? '',
        substitute: (t) => safe(() => c.substituteParams(String(t ?? '')), String(t ?? '')),
    };
}

/* ------------------------------------------------------------------ */
/* lorebooks                                                           */
/* ------------------------------------------------------------------ */

/**
 * What SillyTavern activated on its last real World Info scan. It only says
 * so through an event, so listen once and keep the latest.
 */
let lastActivated = null;
function listenForActivations(c) {
    if (listenForActivations.done || !c?.eventSource?.on || !c.eventTypes?.WORLD_INFO_ACTIVATED) return;
    listenForActivations.done = true;
    c.eventSource.on(c.eventTypes.WORLD_INFO_ACTIVATED, (entries) => {
        lastActivated = { at: Date.now(), entries: (entries ?? []).map(e => ({ world: e.world, uid: e.uid })) };
    });
}

/**
 * Load the lorebooks a canvas could need. Only runs when some canvas has a
 * Lorebook block, so nobody else pays for the lookups.
 *
 * The chat's, persona's and character's own lorebooks come from getContext().
 * The global selection, a character's extra lorebooks and the matching
 * defaults are not exposed there, so they are read from SillyTavern's
 * world-info module if it can be reached, and simply left out if not.
 */
async function loadLore(c, activated) {
    const out = { sources: { chat: [], character: [], persona: [], global: [] }, books: {}, activated, defaults: { depth: 2 }, errors: [], names: [] };
    const graphs = Object.values(safe(() => settings().graphs) ?? {});
    const nodes = graphs.flatMap(g => Object.values(g?.nodes ?? {})).filter(n => n?.type === NODE_TYPES.LOREBOOK);
    if (!nodes.length || typeof c.loadWorldInfo !== 'function') return out;

    let WI = null;
    try { WI = await import('/scripts/world-info.js'); } catch { WI = null; }

    const str = (v) => (typeof v === 'string' && v.trim() ? [v.trim()] : []);
    out.sources.chat = str(c.chatMetadata?.world_info);
    const char = safe(() => c.characters?.[c.characterId]);
    const file = String(char?.avatar ?? '').replace(/\.[^/.]+$/, '');
    const extra = safe(() => WI?.world_info?.charLore?.find(e => e.name === file)?.extraBooks) ?? [];
    out.sources.character = [...str(char?.data?.extensions?.world), ...(Array.isArray(extra) ? extra : [])];
    out.sources.persona = str(c.powerUserSettings?.persona_description_lorebook);
    out.sources.global = Array.isArray(safe(() => WI?.selected_world_info)) ? [...WI.selected_world_info] : [];
    out.defaults = {
        depth: Number(safe(() => WI?.world_info_depth)) || 2,
        caseSensitive: !!safe(() => WI?.world_info_case_sensitive),
        wholeWords: !!safe(() => WI?.world_info_match_whole_words),
    };
    out.names = safe(() => c.getWorldInfoNames?.()) ?? [];

    const wanted = new Set([...Object.values(out.sources).flat(), ...nodes.flatMap(n => n.books ?? [])].filter(Boolean));
    for (const name of wanted) {
        try {
            const data = await c.loadWorldInfo(name);
            if (!data) { out.errors.push(`Lorebook "${name}" was not found.`); continue; }
            out.books[name] = Object.values(data.entries ?? {}).map(e => toEntry(e, name));
        } catch (err) {
            out.errors.push(`Could not read lorebook "${name}": ${err?.message ?? err}`);
        }
    }
    return out;
}

/**
 * The context as one graph sees it: if a Lorebook block asks for it, its
 * lorebooks are taken out of SillyTavern's own World Info text, so the same
 * lore is not sent twice. Cached per graph and context.
 */
const loreViews = new WeakMap();
function liveFor(graph, live) {
    const blocks = Object.values(graph.nodes).filter(n => n.type === NODE_TYPES.LOREBOOK && n.excludeFromWI && n.enabled !== false);
    if (!blocks.length || !live?.worldInfo) return live;
    let byGraph = loreViews.get(live);
    if (!byGraph) { byGraph = new Map(); loreViews.set(live, byGraph); }
    const key = blocks.map(b => `${b.id}:${blockBooks(b, live.lore).join('|')}`).join(';');
    const hit = byGraph.get(graph.id);
    if (hit?.key === key) return hit.view;
    const entries = [...new Set(blocks.flatMap(b => blockBooks(b, live.lore)))].flatMap(name => live.lore?.books?.[name] ?? []);
    const sub = live.substitute ?? (t => t);
    const view = {
        ...live,
        worldInfo: {
            before: live.worldInfo.before === null ? null : stripFromWorldInfo(live.worldInfo.before, entries, sub),
            after: live.worldInfo.after === null ? null : stripFromWorldInfo(live.worldInfo.after, entries, sub),
        },
    };
    byGraph.set(graph.id, { key, view });
    return view;
}

/* ------------------------------------------------------------------ */
/* conditions                                                          */
/* ------------------------------------------------------------------ */

function haystack(cond, live, extra = {}) {
    const chat = live.chat ?? [];
    switch (cond.scope) {
        case 'incoming':
            return String(extra.incoming ?? '');
        case 'lastAssistant': {
            const m = [...chat].reverse().find(x => !x.is_user && !x.is_system);
            return m?.mes ?? '';
        }
        case 'chat':
            return chat.map(x => x.mes ?? '').join('\n');
        case 'lastN': {
            const n = Math.max(1, Number(cond.n) || 3);
            return chat.slice(-n).map(x => x.mes ?? '').join('\n');
        }
        case 'lastUser':
        default: {
            const m = [...chat].reverse().find(x => x.is_user);
            return m?.mes ?? '';
        }
    }
}

function matchTerms(text, cond) {
    const terms = String(cond.terms || '')
        .split('\n').map(t => t.trim()).filter(Boolean);
    if (!terms.length) return true;
    const subject = cond.caseSensitive ? text : text.toLowerCase();
    const hit = (t) => {
        if (cond.regex) {
            try { return new RegExp(t, cond.caseSensitive ? '' : 'i').test(text); }
            catch { return false; }
        }
        return subject.includes(cond.caseSensitive ? t : t.toLowerCase());
    };
    switch (cond.matchMode) {
        case 'all': return terms.every(hit);
        case 'none': return !terms.some(hit);
        case 'any':
        default: return terms.some(hit);
    }
}

/** Which of the terms actually occur in the text, for saying why. */
function foundTerms(text, cond) {
    const terms = String(cond.terms || '').split('\n').map(t => t.trim()).filter(Boolean);
    const subject = cond.caseSensitive ? text : text.toLowerCase();
    return terms.filter(t => {
        if (cond.regex) { try { return new RegExp(t, cond.caseSensitive ? '' : 'i').test(text); } catch { return false; } }
        return subject.includes(cond.caseSensitive ? t : t.toLowerCase());
    });
}

/**
 * @returns {{pass: boolean, why: string}}
 */
export function evaluateCondition(node, live, extra = {}) {
    const cond = node.condition ?? { mode: 'always' };
    return evaluateRule(cond, live, extra);
}

const WORDS = (t) => (String(t).trim().match(/\S+/g) ?? []).length;

function compare(a, op, b) {
    switch (op) {
        case 'gt': return a > b;
        case 'lt': return a < b;
        case 'gte': return a >= b;
        case 'lte': return a <= b;
        case 'every': return b > 0 && a > 0 && a % b === 0;
        case 'eq':
        default: return a === b;
    }
}
const OP_WORD = { gt: 'more than', lt: 'fewer than', gte: 'at least', lte: 'at most', eq: 'exactly', every: 'every' };

/** The number a "number" rule compares, and what to call it. */
function numberSource(cond, live, extra) {
    const chat = (live.chat ?? []).filter(m => !m.is_system);
    const text = String(extra.incoming ?? '');
    switch (cond.source) {
        case 'chars': return { value: text.length, label: 'the text coming in, in characters' };
        case 'messages': return { value: chat.length, label: 'the number of messages' };
        case 'turns': return { value: chat.filter(m => m.is_user).length, label: 'the number of your turns' };
        case 'roll': {
            const v = Math.floor((extra.random ?? Math.random)() * 100) + 1;
            return { value: v, label: 'a dice roll (1\u2013100)' };
        }
        case 'variable': {
            const c = ctx();
            const store = cond.scope === 'global' ? c.variables?.global : c.variables?.local;
            const raw = safe(() => store?.get(cond.name));
            const v = Number(raw);
            return { value: raw === undefined || raw === null || raw === '' || Number.isNaN(v) ? null : v, label: `variable ${cond.name || '?'}` };
        }
        case 'found': {
            const found = foundTerms(text, { ...cond, terms: cond.terms });
            let count = 0;
            const subject = cond.caseSensitive ? text : text.toLowerCase();
            for (const t of found) {
                if (cond.regex) { try { count += (text.match(new RegExp(t, cond.caseSensitive ? 'g' : 'gi')) ?? []).length; } catch { /* skip */ } }
                else { const needle = cond.caseSensitive ? t : t.toLowerCase(); count += subject.split(needle).length - 1; }
            }
            return { value: count, label: 'how often the words appear' };
        }
        case 'words':
        default: return { value: WORDS(text), label: 'the text coming in, in words' };
    }
}

/** "22:30" -> minutes past midnight, or null. */
function clock(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
    if (!m) return null;
    return (Number(m[1]) % 24) * 60 + Math.min(59, Number(m[2]));
}

/**
 * One condition, on its own. Blocks use one to decide whether they are
 * included; a Decider key uses a list of them to decide whether it matches.
 * `extra.incoming` is the text wired into a Decider, when there is one.
 * @returns {{pass: boolean, why: string}}
 */
export function evaluateRule(cond, live, extra = {}) {
    cond ??= { mode: 'always' };
    switch (cond.mode) {
        case 'time': {
            const now = extra.now ?? new Date();
            const mins = now.getHours() * 60 + now.getMinutes();
            const from = clock(cond.from), to = clock(cond.to);
            let inRange = true;
            if (from !== null && to !== null) {
                inRange = from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
            }
            const days = Array.isArray(cond.days) && cond.days.length ? cond.days.map(Number) : null;
            const dayOk = !days || days.includes(now.getDay());
            const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            return { pass: inRange && dayOk, why: `time ${cond.from || '?'}\u2013${cond.to || '?'}${days ? ' on chosen days' : ''} (now ${hhmm})` };
        }
        case 'chat': {
            const chat = (live.chat ?? []).filter(m => !m.is_system);
            if (cond.what === 'lastSpeaker') {
                const last = chat[chat.length - 1];
                const who = !last ? 'nobody' : last.is_user ? 'user' : 'character';
                const want = cond.value || 'user';
                return { pass: who === want, why: `last message is from the ${want} (it is from the ${who})` };
            }
            const n = cond.what === 'turn' ? chat.filter(m => m.is_user).length : chat.length;
            const target = Number(cond.value) || 0;
            const label = cond.what === 'turn' ? 'user turns' : 'messages';
            return { pass: compare(n, cond.op || 'gte', target), why: `${label}: ${n}, wanted ${OP_WORD[cond.op || 'gte']} ${target}` };
        }
        case 'length': {
            const text = extra.incoming !== undefined ? String(extra.incoming) : haystack({ scope: 'lastUser' }, live);
            const unit = cond.unit === 'chars' ? 'chars' : 'words';
            const n = unit === 'chars' ? text.length : WORDS(text);
            const target = Number(cond.value) || 0;
            return { pass: compare(n, cond.op || 'gt', target), why: `${n} ${unit === 'chars' ? 'characters' : 'words'}, wanted ${OP_WORD[cond.op || 'gt']} ${target}` };
        }
        case 'lacks': {
            // "Does not contain": a word search that passes when none is found.
            const r = evaluateRule({ ...cond, mode: 'search', matchMode: 'none' }, live, extra);
            return { pass: r.pass, why: r.pass ? r.why.replace(/^no term found/, 'none of the words found') : r.why };
        }
        case 'number': {
            const n = numberSource(cond, live, extra);
            const target = Number(cond.value) || 0;
            if (n.value === null) return { pass: false, why: `${n.label} is not a number` };
            return { pass: compare(n.value, cond.op || 'gt', target), why: `${n.label} is ${n.value}, wanted ${OP_WORD[cond.op || 'gt']} ${target}` };
        }
        case 'ai': {
            const a = extra.ai?.[extra.aiKey?.(cond)];
            const q = String(cond.question ?? '').trim();
            if (!a) return { pass: false, why: `AI was not asked "${q}"`, needsAi: true };
            return { pass: a.yes, why: `AI answered ${a.yes ? 'YES' : 'NO'} to "${q.slice(0, 80)}"${a.unclear ? ' (its answer was unclear, so treated as NO)' : ''}` };
        }
        case 'character': {
            const name = String(live.name2 ?? '');
            const needle = String(cond.value ?? '').trim();
            const pass = needle ? name.toLowerCase().includes(needle.toLowerCase()) : true;
            return { pass, why: `character name contains "${needle}" (it is ${name || 'unknown'})` };
        }
        default:
            break;
    }
    switch (cond.mode) {
        case 'probability': {
            const chance = Math.max(0, Math.min(100, Number(cond.chance ?? 100)));
            const roll = Math.random() * 100;
            const pass = roll < chance;
            return { pass, why: `probability ${chance}% rolled ${roll.toFixed(1)}` };
        }
        case 'search': {
            const text = haystack(cond, live, extra);
            const pass = matchTerms(text, cond);
            const where = { incoming: 'the text coming in', lastUser: 'the last user message', lastAssistant: 'the last reply', lastN: `the last ${cond.n || 3} messages`, chat: 'the whole chat' }[cond.scope || 'lastUser'] ?? cond.scope;
            const found = foundTerms(text, cond);
            const mode = cond.matchMode || 'any';
            return {
                pass,
                found: mode === 'none' ? [] : found,
                why: found.length
                    ? `${mode === 'none' ? 'found' : 'matched'} ${found.slice(0, 3).map(t => `"${t}"`).join(', ')} in ${where}`
                    : `no term found in ${where}`,
            };
        }
        case 'variable': {
            const c = ctx();
            const store = cond.scope === 'global' ? c.variables?.global : c.variables?.local;
            const raw = safe(() => store?.get(cond.name));
            const val = raw ?? '';
            const target = cond.value ?? '';
            let pass;
            switch (cond.op) {
                case 'exists': pass = raw !== undefined && raw !== null && raw !== ''; break;
                case 'neq': pass = String(val) !== String(target); break;
                case 'gt': pass = Number(val) > Number(target); break;
                case 'lt': pass = Number(val) < Number(target); break;
                case 'contains': pass = String(val).includes(String(target)); break;
                case 'eq':
                default: pass = String(val) === String(target);
            }
            return { pass, why: `variable ${cond.name} ${cond.op || 'eq'} ${target}` };
        }
        case 'model': {
            const model = String(live.model || '');
            const needle = String(cond.value || '');
            const pass = needle ? model.toLowerCase().includes(needle.toLowerCase()) : true;
            return { pass, why: `model contains "${needle}" (current: ${model || 'unknown'})` };
        }
        case 'always':
        default:
            return { pass: true, why: 'always' };
    }
}

/* ------------------------------------------------------------------ */
/* deciders                                                            */
/* ------------------------------------------------------------------ */

/** A search rule with no terms would match everything; in a key that is never meant. */
function emptyRule(cond) {
    if (cond?.mode === 'search' || cond?.mode === 'lacks') return !String(cond.terms ?? '').trim();
    if (cond?.mode === 'ai') return !String(cond.question ?? '').trim();
    if (cond?.mode === 'number' && cond.source === 'found') return !String(cond.terms ?? '').trim();
    return false;
}

/**
 * How a Decider routes. `null` means it has not been set up yet: a new
 * Decider starts that way and sends nothing on until you choose.
 * Old canvases saved 'rules' (or nothing) and keep working as 'first'.
 */
export function routingMode(node) {
    if (node?.mode === null || node?.mode === '') return null;
    if (node?.mode === undefined || node.mode === 'rules') return 'first';
    return ['all', 'first', 'random', 'ai'].includes(node.mode) ? node.mode : 'first';
}

/** Whether a decision sends things down this output. */
export function picks(decision, keyId) {
    if (!decision) return false;
    if (Array.isArray(decision.keys)) return decision.keys.includes(keyId);
    return decision.key === keyId;
}

/**
 * Check one output's rules. Rules are checked in order and stopped as soon
 * as the answer is known, so an AI rule is only asked when nothing before it
 * has settled things.
 * @returns {{pass:boolean, why:string, matched:string[], empty?:boolean} | {needs: object, incoming: string}}
 */
export function checkKey(k, live, incoming, extra = {}) {
    const rules = (k.conditions ?? []).filter(c => c && !emptyRule(c));
    if (!rules.length) return { pass: false, why: 'no rules yet', matched: [], empty: true };
    const all = k.match === 'all';
    const results = [];
    let ok = all;
    for (const c of rules) {
        // A rule can read one particular input instead of all of them.
        const text = c.input && extra.inputs ? (extra.inputs[c.input] ?? '') : incoming;
        let r = evaluateRule(c, live, { ...extra, incoming: text });
        if (r.needsAi) return { needs: c, incoming: text };
        if (c.not) r = { pass: !r.pass, why: `NOT (${r.why})`, found: [] };
        results.push(r);
        if (all && !r.pass) { ok = false; break; }
        if (!all && r.pass) { ok = true; break; }
    }
    const why = ok
        ? (all ? results.map(r => r.why).join('; ') : results.find(r => r.pass).why)
        : results.map(r => r.why).join('; ');
    // The words that made it match, for a "Forward result" wire.
    const matched = ok ? [...new Set(results.filter(r => r.pass).flatMap(r => r.found ?? []))] : [];
    return { pass: ok, why, matched };
}

/**
 * Pick a Decider's outputs. No model is involved unless a rule asks one, or
 * the routing mode is "AI sorts".
 *
 *  - all:    every output whose rules match fires
 *  - first:  outputs are checked top to bottom, the first match wins
 *  - random: a weighted pick
 *  - ai:     one model call reads the text and picks the outputs that apply
 *
 * "Otherwise" fires when nothing else does.
 *
 * @param {object} node      the Decider
 * @param {object} live      gathered context
 * @param {string} incoming  all the text wired into it
 * @param {object} [extra]   { inputs: {wireId: text}, ai, aiKey, exclude, random }
 */
export function evaluateDecider(node, live, incoming, extra = {}) {
    const fb = node.fallback ?? { id: 'fallback', name: 'Otherwise' };
    // A key whose loop has run out is taken off the list, so the Decider
    // has to choose something else.
    const gone = extra.exclude ?? null;
    const keys = (node.keys ?? []).filter(k => k && !gone?.has(k.id));
    const decide = (ks, why, fallback = false, matched = []) => ({
        keys: ks.map(k => k.id),
        key: ks[0]?.id ?? null,
        names: ks.map(k => k.name || 'output'),
        name: ks.map(k => k.name || 'output').join(' + ') || 'nothing',
        why, fallback, matched,
    });
    const otherwise = (why) => gone?.has(fb.id) ? decide([], why) : decide([fb], why, true);

    if (node.enabled === false) return otherwise('switched off, so it takes the Otherwise path');

    const mode = routingMode(node);
    if (!mode) return { ...decide([], 'not set up yet: choose how it routes'), unset: true };

    if (mode === 'random') {
        const all = [...keys, ...(gone?.has(fb.id) ? [] : [fb])].map(k => ({ k, w: Math.max(0, Number(k.weight ?? 1)) }));
        const total = all.reduce((n, x) => n + x.w, 0);
        if (total <= 0) return otherwise('every weight is zero');
        let roll = (extra.random ?? Math.random)() * total;
        for (const { k, w } of all) {
            if ((roll -= w) < 0) return decide([k], `weighted pick: ${Math.round(100 * w / total)}% chance`, k === fb);
        }
        return otherwise('weighted pick');
    }

    if (mode === 'ai') {
        if (!keys.length) return otherwise('it has no outputs yet');
        const a = extra.ai?.[`${node.id}|sorter`];
        if (!a) return { needs: { mode: 'sorter' }, incoming, key: null };
        const chosen = keys.filter(k => (a.keys ?? []).includes(k.id));
        if (!chosen.length) return otherwise(a.why || 'the AI picked none of the outputs');
        return decide(chosen, a.why || 'the AI picked it');
    }

    if (mode === 'first') {
        for (const k of keys) {
            const r = checkKey(k, live, incoming, extra);
            if (r.needs) return { needs: r.needs, incoming: r.incoming, key: null };
            if (r.pass) return decide([k], r.why, false, r.matched);
        }
        return otherwise(keys.length ? 'nothing matched' : 'it has no outputs yet');
    }

    // mode === 'all': every output that matches fires.
    const hits = [];
    const whys = [];
    const matched = [];
    for (const k of keys) {
        const r = checkKey(k, live, incoming, extra);
        if (r.needs) return { needs: r.needs, incoming: r.incoming, key: null };
        if (r.pass) { hits.push(k); whys.push(`${k.name || 'output'}: ${r.why}`); matched.push(...r.matched); }
    }
    if (!hits.length) return otherwise(keys.length ? 'nothing matched' : 'it has no outputs yet');
    return decide(hits, whys.join(' · '), false, [...new Set(matched)]);
}

/**
 * Test a Decider against some sample text, output by output, for the test
 * box. Nothing is sent: AI rules and the AI sorter are reported as not asked.
 * @returns {Array<{id:string|null, name:string, pass:boolean|null, why:string}>}
 */
export function explainDecider(node, live, incoming) {
    const mode = routingMode(node);
    const fb = node.fallback ?? { id: 'fallback', name: 'Otherwise' };
    const rows = [];
    if (!mode) return [{ id: null, name: 'Not set up', pass: null, why: 'choose how it routes first' }];
    if (mode === 'random') {
        const all = [...(node.keys ?? []), fb];
        const total = all.reduce((n, k) => n + Math.max(0, Number(k.weight ?? 1)), 0) || 1;
        return all.map(k => ({ id: k.id, name: k.name || 'output', pass: null, why: `${Math.round(100 * Math.max(0, Number(k.weight ?? 1)) / total)}% chance` }));
    }
    if (mode === 'ai') {
        return [...(node.keys ?? []).map(k => ({ id: k.id, name: k.name || 'output', pass: null, why: 'the AI decides at send time' })),
            { id: fb.id, name: fb.name || 'Otherwise', pass: null, why: 'if the AI picks none' }];
    }
    let any = false;
    for (const k of node.keys ?? []) {
        if (mode === 'first' && any) { rows.push({ id: k.id, name: k.name || 'output', pass: false, why: 'not checked: an output above already matched' }); continue; }
        const r = checkKey(k, live, incoming, {});
        if (r.needs) { rows.push({ id: k.id, name: k.name || 'output', pass: null, why: 'needs the AI, which the test box does not ask' }); continue; }
        rows.push({ id: k.id, name: k.name || 'output', pass: r.pass, why: r.why });
        if (r.pass) any = true;
    }
    rows.push({ id: fb.id, name: fb.name || 'Otherwise', pass: !any, why: any ? 'something else matched' : 'nothing else matched' });
    return rows;
}

/* ------------------------------------------------------------------ */
/* block resolution                                                    */
/* ------------------------------------------------------------------ */

function markerContent(identifier, live) {
    switch (identifier) {
        case 'charDescription': return live.card.description ?? '';
        case 'charPersonality': return live.card.personality ?? '';
        case 'scenario': return live.card.scenario ?? '';
        case 'personaDescription': return live.card.persona ?? '';
        case 'dialogueExamples': {
            const ex = live.card.mesExamples;
            return Array.isArray(ex) ? ex.join('\n') : (ex ?? '');
        }
        case 'worldInfoBefore': return live.worldInfo.before;
        case 'worldInfoAfter': return live.worldInfo.after;
        case 'authorsNote':
        case 'summary':
        case 'vectorsMemory':
        case 'vectorsDataBank':
        case 'smartContext': {
            const key = Object.keys(live.extensionPrompts).find(k => k.toLowerCase().includes(identifier.slice(0, 6).toLowerCase()));
            return key ? (live.extensionPrompts[key]?.value ?? '') : '';
        }
        default:
            return null;
    }
}

/** The slice of chat a history block covers, as raw SillyTavern messages. */
function historyWindow(node, live) {
    const chat = (live.chat ?? []).filter(m => !m.is_system);
    const skip = Math.max(0, Number(node.skip) || 0);
    const count = Math.max(0, Number(node.count) || 0);
    const end = chat.length - skip;
    return count > 0 ? chat.slice(Math.max(0, end - count), end) : chat.slice(0, end);
}

function historyMessages(node, live) {
    const all = live.chat ?? [];
    return historyWindow(node, live).map(m => ({
        role: m.is_user ? 'user' : 'assistant',
        content: String(m.mes ?? ''),
        ...(m.name ? { name: String(m.name).replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
        // For a wire's "Send what?" filter: SillyTavern's message number and
        // the speaker's real name. Stripped before anything is sent.
        __idx: all.indexOf(m),
        __speaker: String(m.name ?? (m.is_user ? live.name1 : live.name2) ?? ''),
    }));
}

/**
 * The chat rendered as continuous prose in a single message, rather than as
 * alternating turns.
 *
 * The point is framing. A model handed a user/assistant ping-pong reaches for
 * chat-reply habits; handed a block of narrative it continues the narrative.
 * So the turn structure is dissolved on purpose: no roles, no speaker labels
 * unless you ask for them, just paragraphs.
 */
function historyProse(node, live) {
    const window = historyWindow(node, live);
    if (!window.length) return [];

    const clean = (m) => {
        let text = String(m.mes ?? '').trim();
        if (node.stripAsterisks) {
            // *she turned away* -> she turned away, without eating stray asterisks
            text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
        }
        return text;
    };

    // Group consecutive turns by speaker first, so a run of replies from one
    // side reads as one passage instead of four labelled fragments.
    const groups = [];
    for (const m of window) {
        const text = clean(m);
        if (!text) continue;
        const speaker = m.name ?? (m.is_user ? live.name1 : live.name2) ?? '';
        const last = groups[groups.length - 1];
        if (node.collapseSpeakers !== false && last && last.speaker === speaker) {
            last.texts.push(text);
        } else {
            groups.push({ speaker, texts: [text] });
        }
    }
    if (!groups.length) return [];

    const style = node.nameStyle ?? 'none';
    const paragraphs = groups.map(g => {
        const body = g.texts.join('\n');
        if (!g.speaker || style === 'none') return body;
        if (style === 'inline') return `${g.speaker}: ${body}`;
        return `${g.speaker} — ${body}`;
    });

    const sub = live.substitute;
    const prefix = sub(node.prefix ?? '').trim();
    const suffix = sub(node.suffix ?? '').trim();

    return [{
        role: node.proseRole || 'system',
        content: [prefix, paragraphs.join('\n\n'), suffix].filter(Boolean).join('\n\n'),
    }];
}

/**
 * The messages a single block contributes on its own, before any wires are
 * folded in. Empty array means the block adds nothing.
 * @returns {{messages: Array, warnings: Array<string>}}
 */
export function resolveNode(node, live) {
    const warnings = [];
    const sub = live.substitute;

    switch (node.type) {
        case NODE_TYPES.PROMPT: {
            const content = sub(node.content ?? '').trim();
            if (!content) return { messages: [], warnings };
            return { messages: [{ role: node.role || 'system', content }], warnings };
        }

        case NODE_TYPES.ST: {
            const def = stPrompt(node.identifier);
            if (!def) {
                warnings.push(`"${node.title}" points at SillyTavern prompt "${node.identifier}", which is not in the current preset.`);
                return { messages: [], warnings };
            }
            if (node.override && typeof node.override.content === 'string') {
                const content = sub(node.override.content).trim();
                if (!content) return { messages: [], warnings };
                return { messages: [{ role: node.override.role || def.role || 'system', content }], warnings };
            }
            if (def.identifier === 'chatHistory') {
                const msgs = historyMessages({ count: 0, skip: 0 }, live);
                if (msgs.length > 40) {
                    warnings.push(`"${def.name}" is sending all ${msgs.length} messages. SillyTavern would have trimmed this to fit the context budget — use a Chat history block with a message count if you want a bounded window.`);
                }
                return { messages: msgs, warnings };
            }
            if (def.marker) {
                const raw = markerContent(def.identifier, live);
                if (raw === null) {
                    warnings.push(`"${def.name}" is assembled by SillyTavern and Silly Canvas cannot resolve it yet. It will be skipped.`);
                    return { messages: [], warnings };
                }
                const content = sub(raw).trim();
                if (!content) return { messages: [], warnings };
                return { messages: [{ role: def.role || 'system', content }], warnings };
            }
            const content = sub(def.content ?? '').trim();
            if (!content) return { messages: [], warnings };
            return { messages: [{ role: def.role || 'system', content }], warnings };
        }

        case NODE_TYPES.HISTORY:
            return {
                messages: node.format === 'prose' ? historyProse(node, live) : historyMessages(node, live),
                warnings,
            };

        case NODE_TYPES.LOREBOOK: {
            // On its own (a per-block preview): no wired text to scan.
            const picked = selectLore(node, live, '');
            if (picked.missing.length) warnings.push(`"${node.title}": lorebook ${picked.missing.map(m => `"${m}"`).join(', ')} could not be read.`);
            if (!picked.books.length) warnings.push(`"${node.title}" reads no lorebooks: this chat, character and persona have none, and none is chosen.`);
            return { messages: loreMessages(node, live, picked.entries), warnings };
        }

        case NODE_TYPES.INJECTION: {
            const out = [];
            const wanted = Array.isArray(node.sources) ? node.sources : [];
            for (const key of wanted) {
                const raw = markerContent(key, live);
                const content = sub(raw ?? '').trim();
                if (content) out.push({ role: 'system', content });
            }
            return { messages: out, warnings };
        }

        case NODE_TYPES.GENERATE: {
            // Only reached when this block is the one being assembled for.
            // As a barrier its own text never leaks downstream.
            const content = sub(node.content ?? '').trim();
            if (!content) return { messages: [], warnings };
            return { messages: [{ role: node.role || 'system', content }], warnings };
        }

        case NODE_TYPES.NOTE:
        case NODE_TYPES.OUTPUT:
        default:
            return { messages: [], warnings };
    }
}


/* ------------------------------------------------------------------ */
/* wire modes                                                          */
/* ------------------------------------------------------------------ */

/**
 * What travels along a wire.
 *  - send:     the text (the default, and how every wire worked before)
 *  - activate: nothing. The block it points at only runs when at least one of
 *              its Activate wires fires; it then uses its own content.
 *  - result:   a Decider's decision — the output's name, or the words that
 *              matched — as text. `{{result}}` in the target's text is
 *              replaced with it; otherwise it is added like any wired text.
 */
export const WIRE_MODES = Object.freeze({ SEND: 'send', ACTIVATE: 'activate', RESULT: 'result' });
export const wireMode = (w) => (w?.mode === 'activate' || w?.mode === 'result') ? w.mode : 'send';

/**
 * Whether a block is switched on by its Activate wires. A block with no
 * Activate wires is always on. An Activate wire fires when the block it comes
 * from is itself on: switched on, on a path that was taken, its condition
 * passing — and, from a Decider, when that output is the one chosen.
 *
 * @param {Record<string,string>} choice  Decider id -> chosen key. A Decider
 *        missing from it has not decided yet, and is assumed to fire.
 * @param {Set<string>} cut   blocks on paths a Decider did not take
 * @param {(node:object)=>{pass:boolean}} condOf  the block's own condition
 * @returns {(id:string)=>{on:boolean, why:string}}
 */
export function activationGate(graph, choice, cut, condOf) {
    const memo = new Map();
    const busy = new Set();
    const gate = (id) => {
        if (memo.has(id)) return memo.get(id);
        if (busy.has(id)) return { on: true, why: '' };
        busy.add(id);
        const wires = wiresInto(graph, id).filter(w => wireMode(w) === 'activate');
        let r = { on: true, why: '' };
        if (wires.length) {
            const hit = wires.find(fires);
            r = hit
                ? { on: true, why: `activated by "${graph.nodes[hit.from]?.title ?? '?'}"` }
                : { on: false, why: 'not activated: none of its Activate wires fired' };
        }
        busy.delete(id);
        memo.set(id, r);
        return r;
    };
    const fires = (w) => {
        const src = graph.nodes[w.from];
        if (!src || src.enabled === false || cut.has(src.id)) return false;
        if (src.type === NODE_TYPES.DECIDER) {
            const k = choice[src.id];
            if (Array.isArray(k) && !k.includes(w.port)) return false;
        } else if (!condOf(src).pass) {
            return false;
        }
        return gate(src.id).on;
    };
    return gate;
}

/** The text a "Forward result" wire carries from its Decider. */
function resultText(decision, wire) {
    if (!decision) return '';
    if (wire.result === 'matched' && decision.matched?.length) return decision.matched.join(', ');
    return (decision.names ?? [decision.name]).filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ */
/* the walk                                                            */
/* ------------------------------------------------------------------ */

export const textOf = (messages) => messages.map(m => m.content).filter(Boolean).join('\n\n');

/**
 * Token count. Uses SillyTavern's own tokenizer when it is reachable and falls
 * back to a rough character estimate, which is clearly worse but never throws
 * mid-compile.
 */
export async function countTokens(messages) {
    const text = textOf(messages);
    if (!text) return 0;
    try {
        const n = await ctx().getTokenCountAsync(text);
        if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }
    return Math.ceil(text.length / 4);
}

const byY = (a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id));

/** What a Generate block puts into the prompt below it. */
function generateOutput(node, results, live) {
    const text = results?.[node.id];
    const sub = live.substitute;
    const body = text === undefined
        ? `⟨the answer from "${node.title}" [${String(node.id).slice(-4)}] goes here⟩`
        : String(text).trim();
    if (!body) return [];
    const prefix = sub(node.prefix ?? '').trim();
    const suffix = sub(node.suffix ?? '').trim();
    return [{
        role: node.outputRole || 'system',
        content: [prefix, body, suffix].filter(Boolean).join('\n\n'),
    }];
}

/**
 * Collect the messages that reach `targetId`.
 *
 * @param {object} graph
 * @param {string} targetId  the Output block, or a Generate block whose prompt we are assembling
 * @param {object} live      gathered context
 * @param {Record<string,string>} results  answers from Generate blocks already run
 * @returns {{messages: Array, warnings: Array<string>, trace: Array, pending: Array<string>}}
 */
export function collect(graph, targetId, live, results = {}, decisions = {}, { raw = false } = {}) {
    live = liveFor(graph, live);
    const warnings = [];
    /** The entries each Lorebook block sent, for its trace and Forward result wires. */
    const fired = new Map();
    const trace = [];
    const pending = [];
    const memo = new Map();
    const seenTwice = new Set();
    /** Where each block's text sits in reading order, for sorting the trace to match. */
    const keyOf = new Map();

    /**
     * The path a Decider takes, deciding it now if it has not been. It can
     * only decide once every Generate block feeding it has answered: until
     * then the text it reads does not exist. In that case (a preview, before
     * anything has run) it follows the fallback path and says so.
     */
    // Settle every Decider upstream before walking, because which blocks
    // count at all depends on what they chose. One that cannot choose yet
    // (it reads a Generate answer that does not exist) is shown following its
    // fallback, and marked as provisional.
    const choice = {};
    const provisional = {};
    for (const dec of upstreamDeciders(graph, targetId)) {
        const d = tryDecide(graph, dec, live, results, decisions);
        if (d) { choice[dec.id] = d.keys ?? [d.key]; continue; }
        provisional[dec.id] = {
            keys: dec.fallback?.id ? [dec.fallback.id] : [],
            names: [dec.fallback?.name || 'Otherwise'],
            key: dec.fallback?.id,
            name: dec.fallback?.name || 'Otherwise',
            why: 'decided at send time, once the text it reads has been written \u2014 this preview follows the fallback path',
            fallback: true,
            provisional: true,
        };
        choice[dec.id] = provisional[dec.id].keys;
    }
    const cut = cutNodes(graph, choice);
    const decisionFor = (dec) => decisions[dec.id] ?? provisional[dec.id] ?? { keys: [dec.fallback?.id], key: dec.fallback?.id, name: dec.fallback?.name, why: '', fallback: true };
    // One answer per block per walk, so a probability roll cannot say yes to
    // the Activate check and no a moment later.
    const conds = new Map();
    const condOf = (n) => {
        if (!conds.has(n.id)) conds.set(n.id, n.enabled === false ? { pass: false, why: 'switched off' } : evaluateCondition(n, live));
        return conds.get(n.id);
    };
    const gate = activationGate(graph, choice, cut, condOf);

    function contribute(nodeId, isTarget = false) {
        if (memo.has(nodeId)) {
            seenTwice.add(nodeId);
            return structuredClone(memo.get(nodeId));
        }
        const node = graph.nodes[nodeId];
        if (!node) return [];

        if (cut.has(nodeId) && !isTarget) {
            trace.push({ id: nodeId, title: node.title, status: 'skipped', why: 'on a path its Decider did not take' });
            memo.set(nodeId, []);
            return [];
        }

        const off = node.enabled === false;
        const cond = condOf(node);

        if (!isTarget && !off) {
            const g = gate(nodeId);
            if (!g.on) {
                trace.push({ id: nodeId, title: node.title, status: 'skipped', why: g.why });
                memo.set(nodeId, []);
                return [];
            }
        }

        // A Generate block is a barrier. Unless it IS the thing we are
        // assembling a prompt for, its own inputs stay on its side of the wall
        // and only its answer travels on.
        if (node.type === NODE_TYPES.GENERATE && !isTarget) {
            if (!cond.pass) {
                trace.push({ id: nodeId, title: node.title, status: off ? 'off' : 'skipped', why: cond.why });
                memo.set(nodeId, []);
                return [];
            }
            const out = generateOutput(node, results, live).map(m => ({ ...m, __y: node.y }));
            keyOf.set(nodeId, node.y);
            if (results?.[node.id] === undefined) pending.push(node.id);
            trace.push({
                id: nodeId,
                title: node.title,
                status: results?.[node.id] === undefined ? 'pending' : 'in',
                why: 'model call',
                chars: textOf(out).length,
            });
            memo.set(nodeId, structuredClone(out));
            return out;
        }

        const incoming = wiresInto(graph, nodeId)
            .map(w => ({ wire: w, src: graph.nodes[w.from] }))
            .filter(x => !!x.src)
            // A Decider's paths not taken contribute nothing.
            .filter(x => !cut.has(x.src.id))
            .filter(x => x.src.type !== NODE_TYPES.DECIDER || picks(decisionFor(x.src), x.wire.port))
            // Activate wires carry nothing; they only switched this block on.
            .filter(x => wireMode(x.wire) !== 'activate')
            .sort((a, b) => byY(a.src, b.src));

        // "Forward result" wires from a Decider carry its decision. If this
        // block's text has {{result}} in it, the decision goes there;
        // otherwise it is added like any other wired text.
        const resultWires = wiresInto(graph, nodeId).filter(w => wireMode(w) === 'result' && isResultSource(graph.nodes[w.from]));
        const macro = /\{\{result\}\}/i;
        const hasMacro = resultWires.length > 0 && [node.content, node.override?.content].some(t => typeof t === 'string' && macro.test(t));
        let viewNode = node;
        if (hasMacro) {
            const valueList = incoming
                .filter(x => wireMode(x.wire) === 'result' && isResultSource(x.src))
                .map(x => resultFor(x.src, x.wire))
                .filter(Boolean);
            const values = [...new Set(valueList)].join(', ');
            const fill = (t) => typeof t === 'string' ? t.replace(/\{\{result\}\}/gi, values) : t;
            viewNode = { ...node, content: fill(node.content), ...(node.override ? { override: { ...node.override, content: fill(node.override.content) } } : {}) };
        }

        // The trace entry for this block is written only after its inputs have
        // been walked, so the trace reads in the order the prompt is sent:
        // upstream blocks first, then this one.
        let own = [];
        let entry = null;
        if (!cond.pass) {
            entry = { id: nodeId, title: node.title, status: off ? 'off' : 'skipped', why: cond.why };
        } else {
            // A Lorebook block is resolved below, once its wired text is known.
            const res = node.type === NODE_TYPES.LOREBOOK ? { messages: [], warnings: [] } : resolveNode(viewNode, live);
            own = res.messages;
            warnings.push(...res.warnings);
            if (node.type === NODE_TYPES.DECIDER && !isTarget) {
                const d = decisionFor(node);
                entry = {
                    id: nodeId,
                    title: node.title,
                    status: d.provisional ? 'pending' : 'in',
                    why: `\u2192 ${d.name}: ${d.why}`,
                    decision: d.keys ?? [d.key],
                    unset: !!d.unset,
                    chars: 0,
                };
            } else if (node.type !== NODE_TYPES.OUTPUT && node.type !== NODE_TYPES.NOTE && node.type !== NODE_TYPES.GENERATE && node.type !== NODE_TYPES.DECIDER) {
                entry = {
                    id: nodeId,
                    title: node.title,
                    status: own.length ? 'in' : 'empty',
                    why: (!isTarget && gate(nodeId).why) || cond.why,
                    chars: textOf(own).length,
                };
            }
        }
        const ownFirstTrace = node.type === NODE_TYPES.GENERATE && node.contentPosition === 'before';
        if (entry && ownFirstTrace) trace.push(entry);

        const before = [];
        const appendText = [];
        const prependText = [];

        for (const { wire, src } of incoming) {
            // The wire's "Send what?" filter decides which part of the
            // upstream block actually crosses it.
            let up;
            if (wireMode(wire) === 'result' && isResultSource(src)) {
                contribute(src.id);            // for its trace entry; the result is sent instead of its text
                if (hasMacro) continue;         // already placed into {{result}}
                const text = resultFor(src, wire);
                up = text ? [{ role: node.role || 'system', content: text, __y: src.y }] : [];
            } else {
                up = applySelect(contribute(src.id), wire.select, live);
            }
            if (!up.length) continue;
            switch (wire.kind) {
                case WIRE_KINDS.APPEND: appendText.push(textOf(up)); break;
                case WIRE_KINDS.PREPEND: prependText.push(textOf(up)); break;
                default: before.push(...up); break;
            }
        }

        // A Lorebook block reads what is wired into it (to scan for keys);
        // that text stops here, like a Generate block's question.
        if (node.type === NODE_TYPES.LOREBOOK && cond.pass) {
            const scan = [...prependText, textOf(before), ...appendText].filter(Boolean).join('\n\n');
            before.length = 0; appendText.length = 0; prependText.length = 0;
            const picked = selectLore(viewNode, live, scan);
            fired.set(nodeId, picked.entries);
            own = loreMessages(viewNode, live, picked.entries);
            if (picked.missing.length) warnings.push(`"${node.title}": lorebook ${picked.missing.map(m => `"${m}"`).join(', ')} could not be read.`);
            if (!picked.books.length) warnings.push(`"${node.title}" reads no lorebooks: this chat, character and persona have none, and none is chosen.`);
            if (entry) {
                const names = picked.entries.map(e => e.title || `#${e.uid}`);
                entry.status = own.length ? 'in' : 'empty';
                entry.chars = textOf(own).length;
                entry.why = `${names.length} entr${names.length === 1 ? 'y' : 'ies'}${picked.estimated ? ' (estimated)' : ''}${names.length ? `: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}` : ''}`;
                entry.lore = picked.entries.map(e => ({ title: e.title, book: e.book, why: e.why }));
            }
        }

        if (appendText.length || prependText.length) {
            if (!own.length) {
                const salvage = [...prependText, ...appendText].filter(Boolean).join('\n\n');
                if (salvage) {
                    warnings.push(`"${node.title}" has nothing of its own to append to, so its wired text was sent as a separate message.`);
                    own = [{ role: node.role || 'system', content: salvage }];
                }
            } else {
                if (prependText.length) {
                    own[0] = { ...own[0], content: [...prependText, own[0].content].filter(Boolean).join('\n\n') };
                }
                if (appendText.length) {
                    const last = own.length - 1;
                    own[last] = { ...own[last], content: [own[last].content, ...appendText].filter(Boolean).join('\n\n') };
                }
            }
        }

        if (entry && !ownFirstTrace) trace.push(entry);

        // A loop that came back here brings its last result with it.
        const back = live.loopInputs?.[nodeId];
        if (back && String(back.text ?? '').trim()) {
            before.push({
                role: 'system',
                content: `${back.label || 'Your previous attempt, to improve on:'}\n\n${String(back.text).trim()}`,
                __y: Math.max(node.y, ...before.map(m => m.__y ?? node.y)) + 0.0005,
            });
        }

        // Reading order is vertical, all the way down. Every message keeps the
        // height of the block it came from, so the System Prompt at the top of
        // the canvas goes first even when it arrives through a block further
        // down. The one constraint: a block's own text is read after what is
        // wired into it, so its place is never above its own inputs.
        const inputs = before.map(m => ({ ...m, __y: m.__y ?? graph.nodes[nodeId]?.y ?? 0 }));
        const lo = inputs.length ? Math.min(...inputs.map(m => m.__y)) : node.y;
        const hi = inputs.length ? Math.max(...inputs.map(m => m.__y)) : node.y;
        const ownFirst = ownFirstTrace;
        const ownY = ownFirst ? Math.min(node.y, lo) - 0.001 : Math.max(node.y, hi) + 0.001;
        keyOf.set(nodeId, ownY);
        const mine = own.map(m => ({ ...m, __y: ownY }));
        const result = [...(ownFirst ? mine : []), ...inputs, ...(ownFirst ? [] : mine)]
            .map((m, i) => ({ m, i }))
            .sort((a, b) => (a.m.__y - b.m.__y) || (a.i - b.i))
            .map(x => x.m);
        memo.set(nodeId, structuredClone(result));
        return result;
    }

    const messages = contribute(targetId, true)
        .filter(m => m && typeof m.content === 'string' && m.content.trim().length)
        .map(m => raw ? m : ({ role: m.role || 'system', content: m.content, ...(m.name ? { name: m.name } : {}) }));

    // The trace reads in the same order as the prompt.
    const tk = (t) => keyOf.get(t.id) ?? graph.nodes[t.id]?.y ?? 0;
    trace.splice(0, trace.length, ...trace.map((t, i) => ({ t, i })).sort((a, b) => (tk(a.t) - tk(b.t)) || (a.i - b.i)).map(x => x.t));

    for (const id of seenTwice) {
        const n = graph.nodes[id];
        if (!n || wiresOutOf(graph, id).length <= 1) continue;
        const times = emissionCounts(graph).get(id) ?? 2;
        warnings.push(`"${n.title}" reaches Output down ${times} different paths, so its text is sent ${times} times. That is your wiring, not something injecting it.`);
    }

    return { messages, warnings, trace, pending, fired: Object.fromEntries(fired) };

    function isResultSource(src) {
        return src?.type === NODE_TYPES.DECIDER || src?.type === NODE_TYPES.LOREBOOK;
    }
    /** What a Forward result wire carries: a Decider's decision, or the entries a Lorebook sent. */
    function resultFor(src, wire) {
        if (src.type === NODE_TYPES.LOREBOOK) {
            contribute(src.id);
            return (fired.get(src.id) ?? []).map(e => e.title || `#${e.uid}`).join(', ');
        }
        return resultText(decisionFor(src), wire);
    }
}

/**
 * What one wire carries right now, after its "Send what?" filter. For the
 * inspector's preview; a Generate block that has not run shows a placeholder.
 * @returns {Array<{role:string, content:string}>}
 */
export function wirePreview(graph, wire, live, results = {}) {
    const src = graph.nodes[wire?.from];
    if (!src) return [];
    let msgs;
    if (src.type === NODE_TYPES.GENERATE) {
        msgs = generateOutput(src, results, live);
    } else if (wireMode(wire) === 'result' && src.type === NODE_TYPES.LOREBOOK) {
        const fired = collect(graph, src.id, live, results).fired?.[src.id] ?? [];
        const text = fired.map(e => e.title || `#${e.uid}`).join(', ');
        return text ? [{ role: 'system', content: text }] : [];
    } else {
        // Walk the source as if it were the target, keeping the chat numbers
        // the filter needs, then apply the filter.
        const tmp = { ...graph, nodes: { ...graph.nodes }, wires: { ...graph.wires } };
        msgs = collect(tmp, src.id, live, results, {}, { raw: true }).messages;
    }
    return applySelect(msgs, wire.select, live).map(m => ({ role: m.role || 'system', content: m.content }));
}

/**
 * Decide a Decider if it can be decided yet, and remember the answer in
 * `decisions` so it is made once per send. Returns null while a Generate
 * block it reads from has not answered.
 */
export function tryDecide(graph, dec, live, results = {}, decisions = {}) {
    if (decisions[dec.id]) return decisions[dec.id];
    // Rules that only look at the chat, the time or variables do not need the
    // incoming text, so they can decide before anything upstream has run.
    let incoming = '';
    let inputs = null;
    if (readsIncoming(dec)) {
        const inner = collect(graph, dec.id, live, results, decisions);
        if (inner.pending.length) return null;
        incoming = textOf(inner.messages);
        inputs = deciderInputs(graph, dec, live, results, decisions);
    }
    const r = evaluateDecider(dec, live, incoming, { inputs, ai: live.aiAnswers ?? {}, aiKey: (c) => aiRuleKey(dec, c), exclude: live.excludedKeys?.[dec.id] ?? null });
    if (r.needs) {
        // An AI rule (or the AI sorter) has to be asked before this can be
        // decided. The runner asks it and tries again; a preview never asks,
        // so it stays open.
        const key = r.needs.mode === 'sorter' ? `${dec.id}|sorter` : aiRuleKey(dec, r.needs);
        (live.aiWanted ??= new Map()).set(key, { dec, cond: r.needs, incoming: r.incoming ?? incoming });
        return null;
    }
    const d = { ...r, title: dec.title };
    decisions[dec.id] = d;
    return d;
}

/**
 * The text arriving on each wire into a Decider, by wire id, so a rule can
 * read one input on its own. Uses the same filters as the walk.
 */
export function deciderInputs(graph, dec, live, results = {}, decisions = {}) {
    const out = {};
    for (const w of wiresInto(graph, dec.id)) {
        if (wireMode(w) === 'activate') continue;
        out[w.id] = textOf(wirePreview(graph, w, live, results));
    }
    return out;
}

/** The blocks wired into a Decider, as its named inputs: [{wireId, title}]. */
export function deciderInputList(graph, dec) {
    return wiresInto(graph, dec.id)
        .filter(w => wireMode(w) !== 'activate' && graph.nodes[w.from])
        .map(w => ({ wireId: w.id, title: graph.nodes[w.from].title || 'Untitled', y: graph.nodes[w.from].y }))
        .sort((a, b) => a.y - b.y);
}

/** A stable name for one AI rule's answer within one send. */
export function aiRuleKey(dec, cond) {
    const k = (dec.keys ?? []).find(k => (k.conditions ?? []).includes(cond));
    const i = k ? k.conditions.indexOf(cond) : -1;
    return `${dec.id}|${k?.id ?? '?'}|${i}`;
}

/** Whether any of a Decider's rules read the text wired into it. */
export function readsIncoming(dec) {
    const mode = routingMode(dec);
    if (dec.enabled === false || !mode || mode === 'random') return false;
    if (mode === 'ai') return (dec.keys ?? []).length > 0;
    return (dec.keys ?? []).some(k => (k.conditions ?? []).some(c =>
        c && !emptyRule(c) && (
            ((c.mode === 'search' || c.mode === 'lacks') && c.scope === 'incoming')
            || c.mode === 'length' || c.mode === 'ai'
            || (c.mode === 'number' && ['words', 'chars', 'found', undefined].includes(c.source)))));
}

/**
 * Every block that can still matter to this send. A Decider that has chosen
 * cuts off its other paths; one that cannot choose yet keeps all of them.
 * Generate blocks outside this set are never called.
 */
export function liveNodes(graph, live, results = {}, decisions = {}) {
    const out = outputNode(graph);
    const seen = new Set();
    if (!out) return seen;
    const choice = {};
    for (const dec of upstreamDeciders(graph, out.id)) {
        const d = tryDecide(graph, dec, live, results, decisions);
        if (d) choice[dec.id] = d.keys ?? [d.key];
    }
    const cut = cutNodes(graph, choice);
    // A probability roll is not known until the real walk, so assume it passes:
    // better to run a block that ends up unused than to miss one that is used.
    const gate = activationGate(graph, choice, cut, (n) => n.condition?.mode === 'probability' ? { pass: true } : evaluateCondition(n, live));
    const stack = [out.id];
    // A block that only switches another on: follow its own Activate wires
    // up to any Decider, because that Decider still has to be able to choose.
    const gateSeen = new Set();
    const switchOnly = (id) => {
        if (gateSeen.has(id)) return;
        gateSeen.add(id);
        for (const w of wiresInto(graph, id)) {
            if (wireMode(w) !== 'activate') continue;
            const src = graph.nodes[w.from];
            if (!src || cut.has(src.id)) continue;
            if (src.type === NODE_TYPES.DECIDER) stack.push(src.id); else switchOnly(src.id);
        }
    };
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        if (id !== out.id && !gate(id).on) continue;
        seen.add(id);
        for (const w of wiresInto(graph, id)) {
            const src = graph.nodes[w.from];
            if (!src || cut.has(src.id)) continue;
            // What sits behind an Activate wire only has to be switched on,
            // not run: its text is never used here. A Decider is the
            // exception, since it has to read its inputs to choose.
            if (wireMode(w) === 'activate' && src.type !== NODE_TYPES.DECIDER) { switchOnly(src.id); continue; }
            if (src.type === NODE_TYPES.DECIDER && Array.isArray(choice[src.id]) && !choice[src.id].includes(w.port)) continue;
            stack.push(src.id);
        }
    }
    return seen;
}

/** Every Decider with a path into this block. */
function upstreamDeciders(graph, nodeId) {
    const found = [];
    const seen = new Set([nodeId]);
    const stack = [nodeId];
    while (stack.length) {
        const id = stack.pop();
        for (const w of wiresInto(graph, id)) {
            if (seen.has(w.from)) continue;
            seen.add(w.from);
            const src = graph.nodes[w.from];
            if (!src) continue;
            if (src.type === NODE_TYPES.DECIDER) found.push(src);
            stack.push(src.id);
        }
    }
    return found;
}

/**
 * The blocks switched off by what the Deciders chose: everything downstream
 * of a key that was not chosen, up to where that path meets the chosen one
 * again. Output is never switched off.
 *
 * @param {Record<string,string>} choice Decider id -> chosen key id
 */
export function cutNodes(graph, choice) {
    const cut = new Set();
    const outId = outputNode(graph)?.id;
    const forward = (starts) => {
        const seen = new Set();
        const stack = [...starts];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            for (const w of wiresOutOf(graph, id)) stack.push(w.to);
        }
        return seen;
    };
    for (const [decId, key] of Object.entries(choice)) {
        const chosen = Array.isArray(key) ? key : [key];
        const wires = wiresOutOf(graph, decId);
        const taken = forward(wires.filter(w => chosen.includes(w.port)).map(w => w.to));
        const not = forward(wires.filter(w => !chosen.includes(w.port)).map(w => w.to));
        for (const id of not) if (!taken.has(id) && id !== outId && id !== decId) cut.add(id);
    }
    return cut;
}

/** The Generate blocks upstream of a block that it has to wait for. */
export function generateDeps(graph, nodeId) {
    const deps = new Set();
    const seen = new Set();
    const walk = [nodeId];
    while (walk.length) {
        const id = walk.pop();
        for (const w of wiresInto(graph, id)) {
            // Activate wires count too: a block switched on by a Decider has
            // to wait until that Decider can choose.
            if (seen.has(w.from)) continue;
            seen.add(w.from);
            const src = graph.nodes[w.from];
            if (!src) continue;
            if (src.type === NODE_TYPES.GENERATE) deps.add(src.id);
            else walk.push(src.id);
        }
    }
    return deps;
}

/* ------------------------------------------------------------------ */
/* which Generate blocks run, and in what order                        */
/* ------------------------------------------------------------------ */

/**
 * Generate blocks that actually reach the Output, in the order they must run.
 * A block whose answer nothing uses is never called: you should not pay for a
 * request whose result is thrown away.
 */
export function generateOrder(graph) {
    const out = outputNode(graph);
    if (!out) return [];

    // walk backwards from Output, collecting every node that feeds it
    const reaching = new Set();
    const stack = [out.id];
    while (stack.length) {
        const id = stack.pop();
        if (reaching.has(id)) continue;
        reaching.add(id);
        for (const w of wiresInto(graph, id)) stack.push(w.from);
    }

    const gens = [...reaching]
        .map(id => graph.nodes[id])
        .filter(n => n && n.type === NODE_TYPES.GENERATE && n.enabled !== false);

    // depth-first by dependency: a Generate that feeds another must run first
    const ordered = [];
    const state = new Map();
    const visit = (node) => {
        if (state.get(node.id) === 'done') return;
        state.set(node.id, 'busy');
        const deps = [];
        const seen = new Set();
        const walk = [node.id];
        while (walk.length) {
            const id = walk.pop();
            for (const w of wiresInto(graph, id)) {
                if (seen.has(w.from)) continue;
                seen.add(w.from);
                const src = graph.nodes[w.from];
                if (!src) continue;
                if (src.type === NODE_TYPES.GENERATE) deps.push(src);
                else walk.push(src.id);
            }
        }
        for (const d of deps.sort(byY)) if (state.get(d.id) !== 'done') visit(d);
        state.set(node.id, 'done');
        ordered.push(node);
    };
    for (const g of gens.sort(byY)) visit(g);
    return ordered;
}

/**
 * How many times each block's text lands in the final prompt.
 *
 * A block that feeds two blocks which both feed Output is sent twice. That is
 * occasionally what you want and usually a surprise — it reads as "something
 * is injecting my prompt again" when it is really your own wiring. Counting
 * the paths lets the canvas say so on the block itself.
 *
 * @returns {Map<string, number>}
 */
export function emissionCounts(graph) {
    const out = outputNode(graph);
    const counts = new Map();
    if (!out) return counts;

    const paths = (nodeId, seen = new Set()) => {
        if (nodeId === out.id) return 1;
        if (counts.has(nodeId)) return counts.get(nodeId);
        if (seen.has(nodeId)) return 0;          // cycles are refused, but be safe
        seen.add(nodeId);

        let total = 0;
        const self = graph.nodes[nodeId];
        // A Decider's paths are alternatives: only one is ever taken, so the
        // text goes out as often as its busiest path, not the sum of them.
        const alt = self?.type === NODE_TYPES.DECIDER;
        for (const w of wiresOutOf(graph, nodeId)) {
            if (wireMode(w) !== 'send') continue;
            const target = graph.nodes[w.to];
            if (!target) continue;
            // A Generate block is a barrier: what goes into it never travels on,
            // so a path that ends at one does not reach the prompt as this text.
            if (target.type === NODE_TYPES.GENERATE || target.type === NODE_TYPES.LOREBOOK) continue;
            const n = paths(w.to, new Set(seen));
            total = alt ? Math.max(total, n) : total + n;
        }
        counts.set(nodeId, total);
        return total;
    };

    for (const node of Object.values(graph.nodes)) {
        if (node.type === NODE_TYPES.OUTPUT || node.type === NODE_TYPES.NOTE) continue;
        counts.set(node.id, paths(node.id));
    }
    return counts;
}

/** Every node with a path to the Output block. */
export function reachesOutput(graph) {
    const out = outputNode(graph);
    const seen = new Set();
    if (!out) return seen;
    const stack = [out.id];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const w of wiresInto(graph, id)) stack.push(w.from);
    }
    return seen;
}

/**
 * Blocks that are switched on but wired to nothing that reaches Output. They
 * contribute nothing and cost nothing, which is exactly why they are easy to
 * miss: you wire a block up, nothing changes, and there is no error to read.
 */
function strandedWarnings(graph) {
    const reach = reachesOutput(graph);
    const out = [];
    for (const node of Object.values(graph.nodes)) {
        if (node.type === NODE_TYPES.OUTPUT || node.type === NODE_TYPES.NOTE) continue;
        if (node.enabled === false) continue;
        if (reach.has(node.id)) continue;
        out.push(node.type === NODE_TYPES.GENERATE
            ? `"${node.title}" is not wired through to Output, so it never runs and its reply is never used.`
            : `"${node.title}" is not wired through to Output, so nothing in it is sent.`);
    }
    return out;
}

/** Decider keys that go nowhere, and keys that can never match. */
function deciderWarnings(graph) {
    const out = [];
    for (const node of Object.values(graph.nodes)) {
        if (node.type !== NODE_TYPES.DECIDER || node.enabled === false) continue;
        // Loop wires count: a key that goes back up is wired.
        const wired = new Set(Object.values(graph.wires).filter(w => w.from === node.id && w.kind !== WIRE_KINDS.TOGETHER).map(w => w.port));
        // "Otherwise" may be left unwired on purpose: then nothing below
        // this Decider is sent when nothing matches.
        const mode = routingMode(node);
        if (!mode) {
            out.push(`"${node.title}" is not set up yet: choose how it routes. Until then nothing below it is sent.`);
            continue;
        }
        for (const k of node.keys ?? []) {
            if (!wired.has(k.id)) out.push(`"${node.title}": output "${k.name}" is not wired to anything, so choosing it sends nothing below this Decider.`);
            if ((mode === 'all' || mode === 'first') && !(k.conditions ?? []).some(c => c && !emptyRule(c))) {
                out.push(`"${node.title}": output "${k.name}" has no rules yet, so it never fires.`);
            }
            if (mode === 'ai' && !String(k.description ?? '').trim()) {
                out.push(`"${node.title}": output "${k.name}" has no description, so the AI only has its name to go on.`);
            }
        }
    }
    return out;
}

/**
 * Two blocks sharing a name make the preview and the trace unreadable: you
 * cannot tell which "Generate" is which, so you cannot tell which one produced
 * what.
 */
function duplicateTitleWarnings(graph) {
    const byTitle = new Map();
    for (const node of Object.values(graph.nodes)) {
        if (node.type === NODE_TYPES.NOTE) continue;
        const key = String(node.title ?? '').trim().toLowerCase();
        if (!key) continue;
        byTitle.set(key, (byTitle.get(key) ?? 0) + 1);
    }
    const out = [];
    for (const [title, count] of byTitle) {
        if (count > 1) out.push(`${count} blocks are called "${title}". Rename them, or the preview and the trace cannot tell you which is which.`);
    }
    return out;
}

/**
 * The same Generate blocks, grouped into waves. Everything in one wave is
 * independent of everything else in it, so a wave can go out at once; each
 * wave waits for the one before it.
 *
 * @returns {Array<Array<object>>}
 */
export function generateLevels(graph) {
    const order = generateOrder(graph);
    if (!order.length) return [];

    const depth = new Map();
    for (const node of order) {
        // how deep the nearest Generate blocks upstream of this one are
        let deepest = -1;
        const seen = new Set();
        const walk = [node.id];
        while (walk.length) {
            const id = walk.pop();
            for (const w of wiresInto(graph, id)) {
                if (seen.has(w.from)) continue;
                seen.add(w.from);
                const src = graph.nodes[w.from];
                if (!src) continue;
                if (src.type === NODE_TYPES.GENERATE) {
                    if (depth.has(src.id)) deepest = Math.max(deepest, depth.get(src.id));
                } else {
                    walk.push(src.id);
                }
            }
        }
        depth.set(node.id, deepest + 1);
    }

    // A "send together" tie says these blocks go out at the same time, so every
    // block in a tied group takes the deepest wave any of them needs. Nothing
    // flows along the tie; it only decides when they leave.
    if (groupWires(graph).length) {
        const settled = new Set();
        for (const node of order) {
            if (settled.has(node.id)) continue;
            const group = [...togetherGroup(graph, node.id)].filter(id => depth.has(id));
            if (group.length < 2) continue;
            const deepest = Math.max(...group.map(id => depth.get(id)));
            for (const id of group) { depth.set(id, deepest); settled.add(id); }
        }
    }

    const waves = [];
    for (const node of order) {
        const d = depth.get(node.id) ?? 0;
        (waves[d] ??= []).push(node);
    }
    return waves.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Compile a graph into a plan: every model call it will make, in order, with
 * the exact messages each one gets. Nothing is sent.
 *
 * In a plan, a Generate block's answer is not known yet, so downstream blocks
 * show a placeholder where it will land. That is the honest picture of a run
 * you have not paid for.
 *
 * @param {object} graph
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {object} [options.live] pre-gathered context
 * @param {Record<string,string>} [options.results] answers from Generate blocks already run
 */
export async function compile(graph, { dryRun = false, live = null, results = {}, decisions = {} } = {}) {
    if (!graph) return fail('No canvas selected.');
    const out = outputNode(graph);
    if (!out) return fail('This canvas has no Output block.');

    const ctxLive = live ?? await gatherContext({ dryRun });
    const warnings = [];
    const stages = [];

    const waveOf = new Map();
    generateLevels(graph).forEach((wave, i) => wave.forEach(n => waveOf.set(n.id, i)));

    const alive = liveNodes(graph, ctxLive, results, decisions);
    for (const gen of generateOrder(graph)) {
        if (!alive.has(gen.id)) continue;
        const cond = evaluateCondition(gen, ctxLive);
        if (!cond.pass) continue;
        const built = collect(graph, gen.id, ctxLive, results, decisions);
        warnings.push(...built.warnings);
        if (!built.messages.length) {
            warnings.push(`"${gen.title}" has nothing wired into it and no text of its own, so it will be skipped rather than asked an empty question.`);
            continue;
        }
        stages.push({
            id: gen.id,
            node: gen,
            wave: waveOf.get(gen.id) ?? 0,
            name: gen.title,
            messages: built.messages,
            profileId: gen.profileId ?? null,
            maxTokens: Number(gen.maxTokens) || 500,
            trace: built.trace,
            final: false,
        });
    }

    const built = collect(graph, out.id, ctxLive, results, decisions);
    // A Decider behind a Generate block is not on Output's own path, but its
    // choice shaped this prompt, so the trace says what it chose.
    const inTrace = new Set(built.trace.map(t => t.id));
    const hidden = Object.entries(decisions)
        .filter(([id]) => !inTrace.has(id) && alive.has(id) && graph.nodes[id])
        .sort(([a], [b]) => byY(graph.nodes[a], graph.nodes[b]))
        .map(([id, d]) => ({ id, title: graph.nodes[id].title, status: 'in', why: `\u2192 ${d.name}: ${d.why}`, decision: d.keys ?? [d.key], chars: 0 }));
    built.trace.unshift(...hidden);
    warnings.push(...built.warnings);
    warnings.push(...strandedWarnings(graph));
    warnings.push(...deciderWarnings(graph));
    warnings.push(...duplicateTitleWarnings(graph));

    if (!built.messages.length) {
        const emptyChat = !(ctxLive.chat ?? []).length;
        return {
            ok: false,
            quiet: emptyChat,
            reason: emptyChat
                ? 'There are no messages in this chat, so the blocks that read the chat had nothing to give. SillyTavern will build this prompt.'
                : 'The canvas compiled to an empty prompt. Check that blocks are wired into Output and switched on.',
            stages, messages: [], warnings, trace: built.trace, tokens: 0,
        };
    }

    const tokens = await countTokens(built.messages);
    const budget = Number(ctx().maxContext) || 0;
    if (budget && tokens > budget) {
        warnings.push(`This prompt is about ${tokens.toLocaleString()} tokens against a context of ${budget.toLocaleString()}. Silly Canvas does not trim to fit — the provider will reject it or truncate for you.`);
    }

    stages.push({
        id: out.id,
        node: out,
        name: 'Output',
        messages: built.messages,
        profileId: out.profileId ?? null,
        tokens,
        trace: built.trace,
        final: true,
    });

    return { ok: true, stages, messages: built.messages, warnings, trace: built.trace, tokens, live: ctxLive, decisions };

    function fail(reason) {
        return { ok: false, reason, stages: [], messages: [], warnings: [], trace: [], tokens: 0 };
    }
}
