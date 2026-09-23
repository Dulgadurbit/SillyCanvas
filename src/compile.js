/**
 * Prompt Canvas — the compiler.
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

import { ctx, safe, NODE_TYPES, WIRE_KINDS, wiresInto, wiresOutOf, outputNode, togetherGroup, groupWires } from './state.js?v=0.3.0';
import { stPrompt, MARKER_SOURCES } from './library.js?v=0.3.0';

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

    return {
        card,
        chat,
        name1: c.name1,
        name2: c.name2,
        worldInfo: { before: wiBefore, after: wiAfter },
        extensionPrompts: safe(() => c.extensionPrompts) ?? {},
        model: safe(() => c.getChatCompletionModel()) ?? '',
        substitute: (t) => safe(() => c.substituteParams(String(t ?? '')), String(t ?? '')),
    };
}

/* ------------------------------------------------------------------ */
/* conditions                                                          */
/* ------------------------------------------------------------------ */

function haystack(cond, live) {
    const chat = live.chat ?? [];
    switch (cond.scope) {
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

/**
 * @returns {{pass: boolean, why: string}}
 */
export function evaluateCondition(node, live) {
    const cond = node.condition ?? { mode: 'always' };
    switch (cond.mode) {
        case 'probability': {
            const chance = Math.max(0, Math.min(100, Number(cond.chance ?? 100)));
            const roll = Math.random() * 100;
            const pass = roll < chance;
            return { pass, why: `probability ${chance}% rolled ${roll.toFixed(1)}` };
        }
        case 'search': {
            const text = haystack(cond, live);
            const pass = matchTerms(text, cond);
            return { pass, why: `term search (${cond.matchMode || 'any'}) in ${cond.scope || 'lastUser'}` };
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
    return historyWindow(node, live).map(m => ({
        role: m.is_user ? 'user' : 'assistant',
        content: String(m.mes ?? ''),
        ...(m.name ? { name: String(m.name).replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
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
                    warnings.push(`"${def.name}" is assembled by SillyTavern and Prompt Canvas cannot resolve it yet. It will be skipped.`);
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
export function collect(graph, targetId, live, results = {}) {
    const warnings = [];
    const trace = [];
    const pending = [];
    const memo = new Map();
    const seenTwice = new Set();

    function contribute(nodeId, isTarget = false) {
        if (memo.has(nodeId)) {
            seenTwice.add(nodeId);
            return structuredClone(memo.get(nodeId));
        }
        const node = graph.nodes[nodeId];
        if (!node) return [];

        const off = node.enabled === false;
        const cond = off ? { pass: false, why: 'switched off' } : evaluateCondition(node, live);

        // A Generate block is a barrier. Unless it IS the thing we are
        // assembling a prompt for, its own inputs stay on its side of the wall
        // and only its answer travels on.
        if (node.type === NODE_TYPES.GENERATE && !isTarget) {
            if (!cond.pass) {
                trace.push({ id: nodeId, title: node.title, status: off ? 'off' : 'skipped', why: cond.why });
                memo.set(nodeId, []);
                return [];
            }
            const out = generateOutput(node, results, live);
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
            .sort((a, b) => byY(a.src, b.src));

        // The trace entry for this block is written only after its inputs have
        // been walked, so the trace reads in the order the prompt is sent:
        // upstream blocks first, then this one.
        let own = [];
        let entry = null;
        if (!cond.pass) {
            entry = { id: nodeId, title: node.title, status: off ? 'off' : 'skipped', why: cond.why };
        } else {
            const res = resolveNode(node, live);
            own = res.messages;
            warnings.push(...res.warnings);
            if (node.type !== NODE_TYPES.OUTPUT && node.type !== NODE_TYPES.NOTE && node.type !== NODE_TYPES.GENERATE) {
                entry = {
                    id: nodeId,
                    title: node.title,
                    status: own.length ? 'in' : 'empty',
                    why: cond.why,
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
            const up = contribute(src.id);
            if (!up.length) continue;
            switch (wire.kind) {
                case WIRE_KINDS.APPEND: appendText.push(textOf(up)); break;
                case WIRE_KINDS.PREPEND: prependText.push(textOf(up)); break;
                default: before.push(...up); break;
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

        const ownFirst = ownFirstTrace;
        const result = ownFirst ? [...own, ...before] : [...before, ...own];
        memo.set(nodeId, structuredClone(result));
        return result;
    }

    const messages = contribute(targetId, true)
        .filter(m => m && typeof m.content === 'string' && m.content.trim().length)
        .map(m => ({ role: m.role || 'system', content: m.content, ...(m.name ? { name: m.name } : {}) }));

    for (const id of seenTwice) {
        const n = graph.nodes[id];
        if (!n || wiresOutOf(graph, id).length <= 1) continue;
        const times = emissionCounts(graph).get(id) ?? 2;
        warnings.push(`"${n.title}" reaches Output down ${times} different paths, so its text is sent ${times} times. That is your wiring, not something injecting it.`);
    }

    return { messages, warnings, trace, pending };
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
        for (const w of wiresOutOf(graph, nodeId)) {
            const target = graph.nodes[w.to];
            if (!target) continue;
            // A Generate block is a barrier: what goes into it never travels on,
            // so a path that ends at one does not reach the prompt as this text.
            if (target.type === NODE_TYPES.GENERATE) continue;
            total += paths(w.to, new Set(seen));
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
export async function compile(graph, { dryRun = false, live = null, results = {} } = {}) {
    if (!graph) return fail('No canvas selected.');
    const out = outputNode(graph);
    if (!out) return fail('This canvas has no Output block.');

    const ctxLive = live ?? await gatherContext({ dryRun });
    const warnings = [];
    const stages = [];

    const waveOf = new Map();
    generateLevels(graph).forEach((wave, i) => wave.forEach(n => waveOf.set(n.id, i)));

    for (const gen of generateOrder(graph)) {
        const cond = evaluateCondition(gen, ctxLive);
        if (!cond.pass) continue;
        const built = collect(graph, gen.id, ctxLive, results);
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

    const built = collect(graph, out.id, ctxLive, results);
    warnings.push(...built.warnings);
    warnings.push(...strandedWarnings(graph));
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
        warnings.push(`This prompt is about ${tokens.toLocaleString()} tokens against a context of ${budget.toLocaleString()}. Prompt Canvas does not trim to fit — the provider will reject it or truncate for you.`);
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

    return { ok: true, stages, messages: built.messages, warnings, trace: built.trace, tokens, live: ctxLive };

    function fail(reason) {
        return { ok: false, reason, stages: [], messages: [], warnings: [], trace: [], tokens: 0 };
    }
}
