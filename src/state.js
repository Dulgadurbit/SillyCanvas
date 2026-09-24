/**
 * Silly Canvas — state layer.
 *
 * Everything here goes through SillyTavern.getContext(). No deep imports into
 * ST internals: those move between releases, the context object does not.
 *
 * Storage layout, all under extensionSettings['prompt-canvas']:
 *
 *   enabled        master arm switch. Off = SillyTavern behaves normally.
 *   activeGraphId  the graph used when nothing more specific is bound.
 *   graphs         { [id]: Graph }   named, shareable canvas configurations.
 *   library        { folders: [...], prompts: [...] }
 *
 * Bindings live outside this object on purpose:
 *   - a chat pins a graph through chat_metadata, so it travels with the chat
 *   - a character pins a graph through its extension field, so it travels with
 *     the card when you export it
 *
 * Resolution order when deciding which graph to run:
 *   chat binding > character binding > activeGraphId
 */

export const MODULE = 'prompt-canvas';
export const META_KEY = 'promptCanvasGraph';

export const ROLES = ['system', 'user', 'assistant'];

export const NODE_TYPES = {
    PROMPT: 'prompt',
    ST: 'st',
    HISTORY: 'history',
    INJECTION: 'injection',
    /**
     * A model call in the middle of the graph. Everything wired into it is the
     * prompt for that call; what comes out of it is its answer, and that answer
     * is what flows on to whatever sits below. It is a barrier: its inputs do
     * not leak downstream, only its result does.
     */
    GENERATE: 'generate',
    // A send point. What is wired into its top goes to the model; the reply
    // goes to whatever is wired to its bottom.

    OUTPUT: 'output',
    NOTE: 'note',
    /**
     * Picks one path for what is wired into it. Each key is an outgoing port;
     * the first key whose rules match wins, and the fallback key takes
     * everything else. What comes in passes through unchanged down the chosen
     * port only. Paths not taken contribute nothing and cost nothing.
     */
    DECIDER: 'decider',
    /**
     * Lorebook entries (World Info), read straight from the lorebooks, so the
     * canvas decides which are sent and where. What is wired into it is text
     * to scan for keys, and stops there.
     */
    LOREBOOK: 'lorebook',
};

/** A fresh output for a Decider, with one empty word rule to fill in. */
export function newDeciderKey(name = 'Output') {
    return {
        id: uid('k'),
        name,
        match: 'any',
        conditions: [{ mode: 'search', scope: 'incoming', terms: '', matchMode: 'any' }],
        weight: 1,
        description: '',
    };
}

/** Every key of a Decider, fallback last. */
export function deciderKeys(node) {
    if (!node || node.type !== NODE_TYPES.DECIDER) return [];
    return [...(node.keys ?? []), node.fallback].filter(Boolean);
}

export const WIRE_KINDS = {
    APPEND: 'append',
    PREPEND: 'prepend',
    MERGE: 'merge',
    /**
     * Not a data wire at all. It ties two Generate blocks together to say
     * "send these two at the same time and wait for both". Nothing flows
     * along it, so the data logic never sees it.
     */
    TOGETHER: 'together',
    /** @deprecated Replaced by the Generate block, which is far easier to reason about. */
    SEQUENCE: 'sequence',
};

export const ctx = () => globalThis.SillyTavern.getContext();

export function uid(prefix = 'n') {
    return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function safe(fn, fallback = undefined) {
    try { return fn(); } catch { return fallback; }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export function settings() {
    const c = ctx();
    const root = c.extensionSettings ?? c.extension_settings;
    if (!root) throw new Error('Silly Canvas: getContext() exposed no extension settings');
    if (!root[MODULE]) root[MODULE] = {};
    const s = root[MODULE];
    s.enabled ??= false;
    s.graphs ??= {};
    s.activeGraphId ??= null;
    s.library ??= { folders: [], prompts: [] };
    s.showTrace ??= true;
    s.previewOnSend ??= false;
    s.parallel ??= true;
    s.concurrency ??= 2;
    s.ui ??= {};
    s.ui.collapsedFolders ??= [];
    if (!Object.keys(s.graphs).length) {
        const g = blankGraph('Default');
        s.graphs[g.id] = g;
        s.activeGraphId = g.id;
    }
    return s;
}

export function save() {
    safe(() => ctx().saveSettingsDebounced());
}

/* ------------------------------------------------------------------ */
/* graphs                                                              */
/* ------------------------------------------------------------------ */

export function blankGraph(name = 'Untitled') {
    const id = uid('g');
    const outId = uid('out');
    return {
        id,
        name,
        description: '',
        schema: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        view: { x: 0, y: 0, zoom: 1 },
        nodes: {
            [outId]: {
                id: outId,
                type: NODE_TYPES.OUTPUT,
                title: 'Output',
                x: 420,
                y: 640,
                w: 260,
                enabled: true,
                collapsed: false,
            },
        },
        wires: {},
    };
}

export function allGraphs() {
    return Object.values(settings().graphs).map(migrateGraph).sort((a, b) => a.name.localeCompare(b.name));
}

export function getGraph(id) {
    const g = settings().graphs[id] ?? null;
    if (g) migrateGraph(g);
    return g;
}

/**
 * Old graphs may carry 'send after' wires. That idea is gone, replaced by the
 * Generate block, so they become plain merges rather than silently doing
 * something the UI can no longer express.
 */
export function migrateGraph(graph) {
    if (!graph || graph.migrated === 1) return graph;
    for (const w of Object.values(graph.wires ?? {})) {
        if (w.kind === WIRE_KINDS.SEQUENCE) w.kind = WIRE_KINDS.MERGE;
    }
    graph.migrated = 1;
    return graph;
}

export function createGraph(name) {
    const s = settings();
    const g = blankGraph(name || 'Untitled');
    s.graphs[g.id] = g;
    save();
    return g;
}

export function duplicateGraph(id, name) {
    const src = getGraph(id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = uid('g');
    copy.name = name || `${src.name} copy`;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    settings().graphs[copy.id] = copy;
    save();
    return copy;
}

export function deleteGraph(id) {
    const s = settings();
    delete s.graphs[id];
    if (s.activeGraphId === id) {
        s.activeGraphId = Object.keys(s.graphs)[0] ?? null;
    }
    if (!Object.keys(s.graphs).length) {
        const g = blankGraph('Default');
        s.graphs[g.id] = g;
        s.activeGraphId = g.id;
    }
    save();
}

const touchListeners = new Set();

/** Be told about every change to any canvas (undo history listens here). */
export function onGraphTouched(fn) {
    touchListeners.add(fn);
    return () => touchListeners.delete(fn);
}

export function touchGraph(graph) {
    if (graph) graph.updatedAt = Date.now();
    save();
    if (graph) for (const fn of touchListeners) { try { fn(graph); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* bindings                                                            */
/* ------------------------------------------------------------------ */

export function chatBinding() {
    return safe(() => ctx().chatMetadata?.[META_KEY]) ?? null;
}

export function setChatBinding(graphId) {
    const c = ctx();
    const meta = c.chatMetadata;
    if (!meta) return false;
    if (graphId) meta[META_KEY] = graphId;
    else delete meta[META_KEY];
    safe(() => c.saveMetadataDebounced());
    return true;
}

export function characterBinding() {
    const c = ctx();
    const char = safe(() => c.characters?.[c.characterId]);
    return safe(() => char?.data?.extensions?.[MODULE]?.graphId) ?? null;
}

export async function setCharacterBinding(graphId) {
    const c = ctx();
    if (c.characterId === undefined || c.characterId === null) return false;
    await c.writeExtensionField(c.characterId, MODULE, graphId ? { graphId } : {});
    return true;
}

/**
 * Which graph would run right now, and why.
 * @returns {{graph: object|null, source: 'chat'|'character'|'default'|'none'}}
 */
export function resolveGraph() {
    const s = settings();
    const chatId = chatBinding();
    if (chatId && s.graphs[chatId]) return { graph: s.graphs[chatId], source: 'chat' };
    const charId = characterBinding();
    if (charId && s.graphs[charId]) return { graph: s.graphs[charId], source: 'character' };
    if (s.activeGraphId && s.graphs[s.activeGraphId]) return { graph: s.graphs[s.activeGraphId], source: 'default' };
    return { graph: null, source: 'none' };
}

/* ------------------------------------------------------------------ */
/* nodes and wires                                                     */
/* ------------------------------------------------------------------ */

export function defaultNode(type, x, y) {
    const base = {
        id: uid(type),
        type,
        x,
        y,
        w: 260,
        enabled: true,
        collapsed: false,
        condition: { mode: 'always' },
        profileId: null,
    };
    switch (type) {
        case NODE_TYPES.PROMPT:
            return { ...base, title: 'New prompt', role: 'system', content: '', libraryId: null };
        case NODE_TYPES.ST:
            return { ...base, title: 'SillyTavern prompt', identifier: '', override: null, role: null };
        case NODE_TYPES.HISTORY:
            return {
                ...base,
                title: 'Chat history',
                count: 0,
                skip: 0,
                w: 240,
                /** 'turns' keeps one message per turn; 'prose' runs the chat together as paragraphs. */
                format: 'turns',
                nameStyle: 'none',
                stripAsterisks: false,
                collapseSpeakers: true,
                proseRole: 'system',
                prefix: '',
                suffix: '',
            };
        case NODE_TYPES.LOREBOOK:
            return {
                ...base,
                title: 'Lorebook',
                w: 280,
                role: 'system',
                /** Which lorebooks: the ones SillyTavern links, plus any named in `books`. */
                sources: { chat: true, character: true, persona: false, global: false },
                books: [],
                /** 'st' as SillyTavern would · 'scan' keys in the wired text or chat · 'all' · 'constant' · 'picked' */
                mode: 'st',
                scanFrom: 'inputs',   // 'inputs' | 'chat'
                scanDepth: 4,
                includeConstant: true,
                picked: [],           // "book|uid"
                titleFilter: '',
                group: '',
                position: 'any',
                memoryOnly: false,    // only entries written by the Memory Books extension
                skipRecent: 0,
                includeDisabled: false,
                maxEntries: 0,
                tokenBudget: 0,
                order: 'order',       // 'order' | 'recent' | 'alpha'
                titles: false,
                separate: false,
                prefix: '',
                suffix: '',
                excludeFromWI: false,
            };
        case NODE_TYPES.INJECTION:
            return { ...base, title: 'Injections', sources: ['worldInfoBefore', 'worldInfoAfter', 'authorsNote'], w: 240 };
        case NODE_TYPES.GENERATE:
            return {
                ...base,
                title: 'Generate',
                w: 280,
                /** This block's own prompt text, alongside whatever is wired in. */
                content: '',
                role: 'system',
                contentPosition: 'after',
                /** Overrides the model the connection profile would use. */
                model: null,
                maxTokens: 2000,
                /**
                 * Reasoning models spend their token budget thinking before
                 * they write, and that thinking comes out of the same
                 * max_tokens. A sub-call almost never wants it: you are doing
                 * the thinking explicitly with the graph. So it is off unless
                 * you ask for it.
                 */
                thinking: 'off',
                outputRole: 'system',
                prefix: '',
                suffix: '',
                showInChat: true,
                label: '',
                /** Send a closing system instruction as the user turn. See shapeForApi(). */
                instructionAsUser: true,
                /** Passes: 1 runs once; more reruns it on its own answer. */
                repeat: 1,
                repeatStopWhenSame: true,
                /** What to ask on each extra pass. Empty repeats the instruction. */
                repeatPrompt: '',
            };
        case NODE_TYPES.NOTE:
            return { ...base, title: 'Note', content: '', w: 220 };
        case NODE_TYPES.DECIDER:
            return {
                ...base,
                title: 'Decider',
                w: 280,
                /**
                 * How it routes: 'all' (every output that matches), 'first'
                 * (the first match), 'random' (weighted) or 'ai' (one model
                 * call picks). null until you choose: a new Decider does
                 * nothing by accident.
                 */
                mode: null,
                keys: [],
                fallback: { id: uid('k'), name: 'Otherwise', weight: 1 },
                showInChat: true,
            };
        case NODE_TYPES.OUTPUT:
        default:
            return { ...base, type: NODE_TYPES.OUTPUT, title: 'Output', w: 260 };
    }
}

export function addNode(graph, type, x, y) {
    const node = defaultNode(type, x, y);
    graph.nodes[node.id] = node;
    touchGraph(graph);
    return node;
}

/**
 * A copy of a block, placed just below and to the right of it. Its wires are
 * not copied: a copy that silently fed the same places would send its text
 * twice. There is only ever one Output, so it cannot be copied.
 * @param {{withInputs?: boolean}} [opts] also copy the wires coming into it
 */
export function duplicateNode(graph, nodeId, { withInputs = false } = {}) {
    const src = graph.nodes[nodeId];
    if (!src || src.type === NODE_TYPES.OUTPUT) return null;
    const copy = structuredClone(src);
    copy.id = uid(src.type);
    copy.x = (src.x ?? 0) + 40;
    copy.y = (src.y ?? 0) + 40;
    copy.title = `${src.title || 'Untitled'} copy`;
    graph.nodes[copy.id] = copy;
    if (withInputs) {
        for (const w of Object.values(graph.wires)) {
            if (w.to !== nodeId || w.kind === WIRE_KINDS.TOGETHER || w.loop) continue;
            const nw = { ...structuredClone(w), id: uid('w'), to: copy.id };
            graph.wires[nw.id] = nw;
        }
    }
    touchGraph(graph);
    return copy;
}

export function removeNode(graph, nodeId) {
    const node = graph.nodes[nodeId];
    if (!node || node.type === NODE_TYPES.OUTPUT) return false;
    delete graph.nodes[nodeId];
    for (const [wid, w] of Object.entries(graph.wires)) {
        if (w.from === nodeId || w.to === nodeId) delete graph.wires[wid];
    }
    touchGraph(graph);
    return true;
}

export function outputNode(graph) {
    return Object.values(graph.nodes).find(n => n.type === NODE_TYPES.OUTPUT) ?? null;
}

/**
 * Connect two nodes. Refuses self-links, duplicates and cycles, because a
 * cycle in a prompt graph is not a clever loop, it is an infinite prompt.
 */
export function connect(graph, fromId, toId, kind = WIRE_KINDS.APPEND, { port = null } = {}) {
    if (fromId === toId) {
        return { ok: false, reason: graph.nodes[fromId]?.type === NODE_TYPES.GENERATE
            ? 'A block cannot wire to itself. To run a Generate block several times, set Repeat in its settings.'
            : 'A block cannot wire to itself.' };
    }
    if (!graph.nodes[fromId] || !graph.nodes[toId]) return { ok: false, reason: 'Missing block.' };

    if (kind === WIRE_KINDS.TOGETHER) return tieTogether(graph, fromId, toId);

    if (graph.nodes[fromId].type === NODE_TYPES.OUTPUT) return { ok: false, reason: 'Output has no outgoing wire.' };
    if (graph.nodes[fromId].type === NODE_TYPES.NOTE || graph.nodes[toId].type === NODE_TYPES.NOTE) {
        return { ok: false, reason: 'Notes are for you, not for the model.' };
    }
    const src = graph.nodes[fromId];
    if (src.type === NODE_TYPES.DECIDER) {
        const key = deciderKeys(src).find(k => k.id === port);
        if (!key) return { ok: false, reason: 'Drag from one of the Decider\u2019s outputs, so it knows which path this is.' };
    } else {
        port = null;
    }
    const exists = Object.values(graph.wires).some(w =>
        w.kind !== WIRE_KINDS.TOGETHER && w.from === fromId && w.to === toId && (w.port ?? null) === port);
    if (exists) return { ok: false, reason: 'Those blocks are already wired.' };
    let loop = null;
    if (wouldCycle(graph, fromId, toId)) {
        // A wire back up the canvas is a loop. Only a model call or a Decider
        // can close one, because only those can end it: a Generate block by
        // running out of passes or changing nothing, a Decider by choosing a
        // different key. A loop of plain prompts would just repeat forever.
        if (src.type !== NODE_TYPES.GENERATE && src.type !== NODE_TYPES.DECIDER) {
            return { ok: false, reason: 'That would make a loop. Only a Generate block, or a Decider key, can send its result back up.' };
        }
        loop = { max: 3, stopWhenSame: true };
    }
    const wire = { id: uid('w'), from: fromId, to: toId, kind, ...(port ? { port } : {}), ...(loop ? { loop } : {}) };
    graph.wires[wire.id] = wire;
    touchGraph(graph);
    return { ok: true, wire };
}

/**
 * Tie two Generate blocks so they go out at the same time. Nothing flows
 * along the tie; it only says "these two, together, and wait for both".
 */
function tieTogether(graph, aId, bId) {
    const a = graph.nodes[aId];
    const b = graph.nodes[bId];
    if (a.type !== NODE_TYPES.GENERATE || b.type !== NODE_TYPES.GENERATE) {
        return { ok: false, reason: 'Only Generate blocks can be sent together.' };
    }
    const already = Object.values(graph.wires).some(w => w.kind === WIRE_KINDS.TOGETHER
        && ((w.from === aId && w.to === bId) || (w.from === bId && w.to === aId)));
    if (already) return { ok: false, reason: 'Those two are already tied together.' };

    // One feeding the other is a contradiction: a reply cannot arrive before
    // the request that needs it.
    if (feeds(graph, aId, bId) || feeds(graph, bId, aId)) {
        return { ok: false, reason: 'One of those already feeds the other, so they cannot go out at the same time.' };
    }

    const wire = { id: uid('t'), from: aId, to: bId, kind: WIRE_KINDS.TOGETHER };
    graph.wires[wire.id] = wire;
    touchGraph(graph);
    return { ok: true, wire };
}

/** Is there a text path from one block to another? */
function feeds(graph, fromId, toId) {
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
        const cur = stack.pop();
        if (cur === toId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const w of wiresOutOf(graph, cur)) stack.push(w.to);
    }
    return false;
}

export function disconnect(graph, wireId) {
    delete graph.wires[wireId];
    touchGraph(graph);
}

function wouldCycle(graph, fromId, toId) {
    // walking forward from toId must never arrive back at fromId
    const seen = new Set();
    const stack = [toId];
    while (stack.length) {
        const cur = stack.pop();
        if (cur === fromId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const w of Object.values(graph.wires)) {
            if (w.from === cur && !w.loop) stack.push(w.to);
        }
    }
    return false;
}

/**
 * Wires that carry text forward. Grouping ties are not among them, and
 * neither are loop wires: those run only at send time, so everything that
 * reads the graph as a picture (order, preview, reach) sees it without them.
 */
export function wiresInto(graph, nodeId) {
    return Object.values(graph.wires).filter(w => w.to === nodeId && w.kind !== WIRE_KINDS.TOGETHER && !w.loop);
}

export function wiresOutOf(graph, nodeId) {
    return Object.values(graph.wires).filter(w => w.from === nodeId && w.kind !== WIRE_KINDS.TOGETHER && !w.loop);
}

/** Wires that send a result back up the canvas. */
export function loopWires(graph) {
    return Object.values(graph.wires).filter(w => !!w.loop);
}

/**
 * The blocks a loop runs again: everything on a path from where the loop
 * lands down to where it starts, both ends included.
 */
export function loopSection(graph, wire) {
    const forward = new Set();
    const stack = [wire.to];
    while (stack.length) {
        const id = stack.pop();
        if (forward.has(id)) continue;
        forward.add(id);
        for (const w of wiresOutOf(graph, id)) stack.push(w.to);
    }
    const back = new Set();
    const up = [wire.from];
    while (up.length) {
        const id = up.pop();
        if (back.has(id)) continue;
        back.add(id);
        for (const w of wiresInto(graph, id)) up.push(w.from);
    }
    return new Set([...forward].filter(id => back.has(id)));
}

/** The "send these together" ties, which carry nothing. */
export function groupWires(graph) {
    return Object.values(graph.wires).filter(w => w.kind === WIRE_KINDS.TOGETHER);
}

/** Every Generate block tied to this one, directly or through another tie. */
export function togetherGroup(graph, nodeId) {
    const ties = groupWires(graph);
    const group = new Set([nodeId]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const w of ties) {
            if (group.has(w.from) && !group.has(w.to)) { group.add(w.to); grew = true; }
            if (group.has(w.to) && !group.has(w.from)) { group.add(w.from); grew = true; }
        }
    }
    return group;
}

/* ------------------------------------------------------------------ */
/* import / export                                                     */
/* ------------------------------------------------------------------ */

export function exportGraph(id) {
    const g = getGraph(id);
    if (!g) return null;
    return JSON.stringify({ kind: 'prompt-canvas-graph', schema: 1, graph: g }, null, 2);
}

export function importGraph(json) {
    let parsed;
    try { parsed = JSON.parse(json); } catch { return { ok: false, reason: 'That is not valid JSON.' }; }
    const g = parsed?.graph ?? parsed;
    if (!g || typeof g !== 'object' || !g.nodes) return { ok: false, reason: 'No graph found in that file.' };
    const copy = structuredClone(g);
    copy.id = uid('g');
    copy.name = g.name ? `${g.name}` : 'Imported';
    const taken = new Set(allGraphs().map(x => x.name));
    let name = copy.name;
    let n = 2;
    while (taken.has(name)) name = `${copy.name} (${n++})`;
    copy.name = name;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    if (!outputNode(copy)) {
        const out = defaultNode(NODE_TYPES.OUTPUT, 420, 640);
        copy.nodes[out.id] = out;
    }
    settings().graphs[copy.id] = copy;
    save();
    return { ok: true, graph: copy };
}

/* ------------------------------------------------------------------ */
/* small UI state that should survive a re-render                      */
/* ------------------------------------------------------------------ */

export function isFolderCollapsed(key) {
    return settings().ui.collapsedFolders.includes(key);
}

export function setFolderCollapsed(key, collapsed) {
    const list = settings().ui.collapsedFolders;
    const at = list.indexOf(key);
    if (collapsed && at === -1) list.push(key);
    if (!collapsed && at !== -1) list.splice(at, 1);
    save();
}

/** Remove a Decider key and every wire leaving from it. The fallback stays. */
export function removeDeciderKey(graph, node, keyId) {
    if (!node?.keys) return false;
    const at = node.keys.findIndex(k => k.id === keyId);
    if (at === -1) return false;
    node.keys.splice(at, 1);
    for (const [wid, w] of Object.entries(graph.wires)) {
        if (w.from === node.id && w.port === keyId) delete graph.wires[wid];
    }
    touchGraph(graph);
    return true;
}
