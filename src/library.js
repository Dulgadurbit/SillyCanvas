/**
 * Prompt Canvas — the prompt library.
 *
 * Two kinds of entry live side by side in the sidebar:
 *
 *   User prompts   yours, stored in extension settings, organised in folders.
 *   SillyTavern    a read-through view of oai_settings.prompts, so the stock
 *                  prompts (Main, Jailbreak, Char Description, Chat History,
 *                  World Info...) are draggable onto the canvas like anything
 *                  else. This folder is virtual: it is never copied into the
 *                  library, it is read fresh each time, so switching presets
 *                  or characters is reflected immediately.
 *
 * Some ST prompts are "markers": their content is assembled by SillyTavern at
 * generation time rather than stored as text (chat history, world info, the
 * character card fields). Those are flagged so the canvas can render them
 * differently and the compiler knows to resolve them from live context.
 */

import { ctx, settings, save, uid, safe } from './state.js?v=0.6.0';

export const ST_FOLDER_ID = '__sillytavern__';

/** Markers whose content the compiler resolves from live context. */
export const MARKER_SOURCES = {
    chatHistory: 'chat',
    dialogueExamples: 'card.mesExamples',
    charDescription: 'card.description',
    charPersonality: 'card.personality',
    scenario: 'card.scenario',
    personaDescription: 'card.persona',
    worldInfoBefore: 'worldinfo.before',
    worldInfoAfter: 'worldinfo.after',
    authorsNote: 'extensionPrompt',
    summary: 'extensionPrompt',
    vectorsMemory: 'extensionPrompt',
    vectorsDataBank: 'extensionPrompt',
    smartContext: 'extensionPrompt',
};

/* ------------------------------------------------------------------ */
/* user library                                                        */
/* ------------------------------------------------------------------ */

export function lib() {
    const s = settings();
    s.library ??= { folders: [], prompts: [] };
    s.library.folders ??= [];
    s.library.prompts ??= [];
    if (!s.library.folders.length) {
        s.library.folders.push({ id: uid('f'), name: 'My prompts', order: 0 });
    }
    return s.library;
}

export function folders() {
    return [...lib().folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function createFolder(name) {
    const l = lib();
    const f = { id: uid('f'), name: name || 'New folder', order: l.folders.length };
    l.folders.push(f);
    save();
    return f;
}

export function renameFolder(id, name) {
    const f = lib().folders.find(x => x.id === id);
    if (f) { f.name = name; save(); }
    return f;
}

/** Deleting a folder moves its prompts to the first remaining folder rather than destroying them. */
export function deleteFolder(id) {
    const l = lib();
    if (l.folders.length <= 1) return false;
    l.folders = l.folders.filter(f => f.id !== id);
    const fallback = l.folders[0].id;
    for (const p of l.prompts) if (p.folderId === id) p.folderId = fallback;
    save();
    return true;
}

export function prompts(folderId = null) {
    const all = lib().prompts;
    const list = folderId ? all.filter(p => p.folderId === folderId) : all;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

export function getPrompt(id) {
    return lib().prompts.find(p => p.id === id) ?? null;
}

export function createPrompt({ name, content = '', role = 'system', folderId = null } = {}) {
    const l = lib();
    const p = {
        id: uid('p'),
        folderId: folderId ?? folders()[0].id,
        name: name || 'New prompt',
        role,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    l.prompts.push(p);
    save();
    return p;
}

export function updatePrompt(id, patch) {
    const p = getPrompt(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: Date.now() });
    save();
    return p;
}

export function deletePrompt(id) {
    const l = lib();
    l.prompts = l.prompts.filter(p => p.id !== id);
    save();
}

export function searchLibrary(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return prompts();
    return prompts().filter(p =>
        p.name.toLowerCase().includes(q) || String(p.content).toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ */
/* SillyTavern's own prompts                                           */
/* ------------------------------------------------------------------ */

function oai() {
    return safe(() => ctx().chatCompletionSettings) ?? null;
}

/**
 * The prompt order list that applies to the character in view. SillyTavern
 * keys these by character id with 100000 as the global fallback.
 */
function activeOrder() {
    const s = oai();
    if (!s?.prompt_order?.length) return [];
    const c = ctx();
    const chid = c.characterId;
    const char = safe(() => c.characters?.[chid]);
    const byChar = char
        ? s.prompt_order.find(o => String(o.character_id) === String(char.avatar ? chid : chid))
        : null;
    const dummy = s.prompt_order.find(o => Number(o.character_id) === 100000);
    return (byChar ?? dummy ?? s.prompt_order[0])?.order ?? [];
}

/**
 * Stock SillyTavern prompts, in the order SillyTavern would send them,
 * each carrying whether it is currently enabled in the Prompt Manager.
 * @returns {Array<{identifier,name,role,content,marker,enabled,system_prompt,source}>}
 */
export function stPrompts() {
    const s = oai();
    if (!s?.prompts?.length) return [];
    const order = activeOrder();
    const rank = new Map(order.map((o, i) => [o.identifier, i]));
    const enabled = new Map(order.map(o => [o.identifier, o.enabled !== false]));

    return s.prompts
        .filter(p => p && p.identifier)
        .map(p => ({
            identifier: p.identifier,
            name: p.name || p.identifier,
            role: p.role ?? (p.marker ? null : 'system'),
            content: p.marker ? '' : (p.content ?? ''),
            marker: !!p.marker,
            system_prompt: !!p.system_prompt,
            injection_position: p.injection_position ?? null,
            injection_depth: p.injection_depth ?? null,
            enabled: enabled.get(p.identifier) ?? false,
            source: MARKER_SOURCES[p.identifier] ?? null,
            inOrder: rank.has(p.identifier),
            rank: rank.get(p.identifier) ?? 9999,
        }))
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

export function stPrompt(identifier) {
    return stPrompts().find(p => p.identifier === identifier) ?? null;
}

/**
 * Build a starter graph that mirrors SillyTavern's current prompt order, so a
 * new canvas begins as a faithful copy of what ST would have sent rather than
 * as an empty page. Wires every enabled prompt straight into Output.
 */
export function graphFromCurrentOrder(graph, { NODE_TYPES, addNode, connect, outputNode, WIRE_KINDS }) {
    const out = outputNode(graph);
    const list = stPrompts().filter(p => p.inOrder);
    const column = 120;
    const spacing = 132;
    let y = 60;
    for (const p of list) {
        const node = addNode(graph, NODE_TYPES.ST, column, y);
        node.identifier = p.identifier;
        node.title = p.name;
        node.enabled = p.enabled;
        node.w = 280;
        y += spacing;
        if (out) connect(graph, node.id, out.id, WIRE_KINDS.MERGE);
    }
    // Output sits below the stack, so the wires run the way the prompt reads.
    if (out) { out.x = column + 10; out.y = y + 40; out.w = 260; }
    return graph;
}
