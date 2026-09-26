/**
 * Silly Canvas — copy and paste.
 *
 * A clip is a piece of a canvas: some blocks, the wires between them, and any
 * groups they came in. It travels as JSON text on the system clipboard, so it
 * can be pasted into another canvas, another SillyTavern tab, or sent to
 * someone. The library stores saved blocks and groups in the same shape.
 *
 * Only wires with both ends inside the clip come along: a pasted block that
 * silently fed the original's targets would send its text twice.
 */

import { NODE_TYPES, uid, touchGraph } from './state.js?v=0.16.0';

export const CLIP_MARK = 'sillyCanvasClip';

/** What is in memory if the browser will not let us use the clipboard. */
let memory = null;

/**
 * Cut a piece out of a canvas (without changing it).
 * @param {object} graph
 * @param {{nodeIds?: string[], groupIds?: string[]}} what
 * @returns {object|null} the clip
 */
export function makeClip(graph, { nodeIds = [], groupIds = [] } = {}) {
    const groups = groupIds.map(id => graph.groups?.[id]).filter(Boolean);
    const inGroups = new Set(groups.map(g => g.id));
    const ids = new Set(nodeIds);
    for (const n of Object.values(graph.nodes)) if (n.inGroup && inGroups.has(n.inGroup)) ids.add(n.id);
    const nodes = [...ids].map(id => graph.nodes[id])
        .filter(n => n && n.type !== NODE_TYPES.OUTPUT)
        .map(n => {
            const c = structuredClone(n);
            if (c.inGroup && !inGroups.has(c.inGroup)) delete c.inGroup;
            return c;
        });
    if (!nodes.length && !groups.length) return null;
    const kept = new Set(nodes.map(n => n.id));
    const wires = Object.values(graph.wires ?? {})
        .filter(w => kept.has(w.from) && kept.has(w.to))
        .map(w => structuredClone(w));
    const boxes = [
        ...nodes.filter(n => !n.inGroup || !groups.find(g => g.id === n.inGroup)?.collapsed).map(n => ({ x: n.x, y: n.y })),
        ...groups.map(g => g.collapsed || !g.frame ? { x: g.x, y: g.y } : { x: g.frame.x, y: g.frame.y }),
    ];
    const origin = {
        x: Math.min(...boxes.map(b => b.x)),
        y: Math.min(...boxes.map(b => b.y)),
    };
    return { [CLIP_MARK]: 1, origin, nodes, wires, groups: groups.map(g => structuredClone(g)) };
}

/** A clip from pasted text, or null when the text is something else. */
export function readClip(text) {
    let o;
    try { o = JSON.parse(String(text ?? '').trim()); } catch { return null; }
    if (!o || o[CLIP_MARK] !== 1 || !Array.isArray(o.nodes)) return null;
    o.wires = Array.isArray(o.wires) ? o.wires : [];
    o.groups = Array.isArray(o.groups) ? o.groups : [];
    o.origin ??= { x: 0, y: 0 };
    // Only real blocks; a clip is data from outside and never gets an Output.
    o.nodes = o.nodes.filter(n => n && typeof n === 'object' && n.id && n.type && n.type !== NODE_TYPES.OUTPUT
        && Object.values(NODE_TYPES).includes(n.type));
    return o.nodes.length || o.groups.length ? o : null;
}

/**
 * Put a clip on a canvas. Everything gets new ids, so the same clip can be
 * pasted as often as you like, and wires and groups are re-pointed to match.
 * @param {object} graph
 * @param {object} clip
 * @param {{x:number, y:number}|null} at  where its top-left corner goes; null: just beside the original
 * @returns {{nodeIds: string[], groupIds: string[], loose: string[]}} what was added; loose = blocks not in a pasted group
 */
export function pasteClip(graph, clip, at = null) {
    const dx = at ? Math.round(at.x - clip.origin.x) : 40;
    const dy = at ? Math.round(at.y - clip.origin.y) : 40;
    const nodeMap = new Map();
    const wireMap = new Map();
    const groupMap = new Map();
    graph.groups ??= {};

    for (const g of clip.groups) {
        const copy = structuredClone(g);
        copy.id = uid('grp');
        copy.x = Math.round((copy.x ?? 0) + dx);
        copy.y = Math.round((copy.y ?? 0) + dy);
        if (copy.frame) copy.frame = { ...copy.frame, x: Math.round(copy.frame.x + dx), y: Math.round(copy.frame.y + dy) };
        groupMap.set(g.id, copy.id);
        graph.groups[copy.id] = copy;
    }
    for (const n of clip.nodes) nodeMap.set(n.id, uid(n.type));
    for (const w of clip.wires) if (nodeMap.has(w.from) && nodeMap.has(w.to)) wireMap.set(w.id, uid('w'));

    const loose = [];
    for (const n of clip.nodes) {
        const copy = structuredClone(n);
        copy.id = nodeMap.get(n.id);
        copy.x = Math.round((copy.x ?? 0) + dx);
        copy.y = Math.round((copy.y ?? 0) + dy);
        if (copy.inGroup && groupMap.has(copy.inGroup)) copy.inGroup = groupMap.get(copy.inGroup);
        else { delete copy.inGroup; loose.push(copy.id); }
        // A Decider rule can read one particular input, named by its wire.
        for (const k of copy.keys ?? []) for (const c of k.conditions ?? []) {
            if (!c.input) continue;
            if (wireMap.has(c.input)) c.input = wireMap.get(c.input);
            else delete c.input;
        }
        graph.nodes[copy.id] = copy;
    }
    for (const w of clip.wires) {
        if (!wireMap.has(w.id)) continue;
        const copy = structuredClone(w);
        copy.id = wireMap.get(w.id);
        copy.from = nodeMap.get(w.from);
        copy.to = nodeMap.get(w.to);
        graph.wires[copy.id] = copy;
    }
    touchGraph(graph);
    return { nodeIds: [...nodeMap.values()], groupIds: [...groupMap.values()], loose };
}

/** Put a clip on the clipboard. Resolves to true when the system clipboard took it. */
export async function toClipboard(clip) {
    memory = clip;
    try {
        await navigator.clipboard.writeText(JSON.stringify(clip));
        return true;
    } catch {
        return false;
    }
}

/** The clip on the clipboard, or the last one copied here when the clipboard cannot be read. */
export async function fromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        const c = readClip(text);
        if (c) return c;
        if (text && text.trim()) return { text };
    } catch { /* not allowed: use what we have */ }
    return memory;
}

/** The last clip copied in this session. */
export function lastClip() {
    return memory;
}

/** A few words for what a clip holds. */
export function describeClip(clip) {
    const n = clip?.nodes?.length ?? 0;
    const g = clip?.groups?.length ?? 0;
    if (g === 1 && clip.nodes.every(x => x.inGroup === clip.groups[0].id)) return `group "${clip.groups[0].title || 'Group'}" (${n} block${n === 1 ? '' : 's'})`;
    if (!g && n === 1) return `"${clip.nodes[0].title || 'Untitled'}"`;
    return `${n} block${n === 1 ? '' : 's'}${g ? ` and ${g} group${g === 1 ? '' : 's'}` : ''}`;
}
