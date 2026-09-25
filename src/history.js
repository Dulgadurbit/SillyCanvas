/**
 * Silly Canvas — undo and redo.
 *
 * Every change to a canvas goes through touchGraph(), so this listens there
 * rather than asking each button to remember to record itself. It keeps
 * whole-canvas snapshots (a canvas is small: blocks and wires, not the chat)
 * and makes one undo step per action:
 *
 *   - adding, deleting, wiring, switching on or off: one step each, and
 *     several changes made by one click (seeding from SillyTavern) are one step
 *   - moving a block: one step, recorded when you let go
 *   - typing: one step per pause, not one per letter
 *
 * The history lives for this session only. Pan and zoom are not steps.
 */

const LIMIT = 50;
const TYPING_PAUSE = 700;

/** @type {Map<string, {undo: Array, redo: Array, last: string, sig: string}>} */
const stacks = new Map();
const pending = new Map();      // graph id -> timer
const listeners = new Set();

const snapshot = (g) => JSON.stringify({ name: g.name, description: g.description ?? '', nodes: g.nodes, wires: g.wires, groups: g.groups ?? {} });

/** The shape of a canvas: which blocks and wires exist, where, and on or off. */
function signature(g) {
    const nodes = Object.values(g.nodes ?? {}).map(n => `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${n.enabled !== false}:${n.inGroup ?? ''}`).sort();
    const wires = Object.values(g.wires ?? {}).map(w => `${w.id}:${w.kind}:${w.port ?? ''}`).sort();
    const groups = Object.values(g.groups ?? {}).map(x => `${x.id}:${x.collapsed ? 1 : 0}:${x.enabled !== false}:${Math.round(x.x ?? 0)}:${Math.round(x.y ?? 0)}:${x.frame ? [x.frame.x, x.frame.y, x.frame.w, x.frame.h].map(Math.round).join('/') : ''}`).sort();
    return `${nodes.join(',')}|${wires.join(',')}|${groups.join(',')}`;
}

function stack(g) {
    let s = stacks.get(g.id);
    if (!s) {
        s = { undo: [], redo: [], last: snapshot(g), sig: signature(g) };
        stacks.set(g.id, s);
    }
    return s;
}

const notify = (g) => { for (const fn of listeners) { try { fn(g); } catch { /* ignore */ } } };

/** Start keeping history for a canvas, from how it is right now. */
export function track(g) {
    if (g?.id) stack(g);
}

/** Called on every change. Decides when the change becomes an undo step. */
export function noteChange(g) {
    if (!g?.id || !stacks.has(g.id)) return;
    const s = stack(g);
    clearTimeout(pending.get(g.id));
    if (signature(g) !== s.sig) {
        // Structural: commit once the current click has finished, so a
        // single action that makes several changes is still one step.
        pending.set(g.id, setTimeout(() => commit(g), 0));
    } else {
        pending.set(g.id, setTimeout(() => commit(g), TYPING_PAUSE));
    }
    notify(g);
}

/** Record any change still waiting (a pause in typing that has not come yet). */
export function flush(g) {
    if (!g?.id || !pending.has(g.id)) return;
    clearTimeout(pending.get(g.id));
    pending.delete(g.id);
    commit(g);
}

function commit(g) {
    pending.delete(g.id);
    const s = stack(g);
    const now = snapshot(g);
    if (now === s.last) return;
    s.undo.push({ state: s.last, label: describe(JSON.parse(s.last), JSON.parse(now)) });
    if (s.undo.length > LIMIT) s.undo.shift();
    s.redo = [];
    s.last = now;
    s.sig = signature(g);
    notify(g);
}

function restore(g, state) {
    const o = JSON.parse(state);
    g.nodes = o.nodes;
    g.wires = o.wires;
    g.groups = o.groups ?? {};
    g.name = o.name;
    g.description = o.description;
    const s = stack(g);
    s.last = state;
    s.sig = signature(g);
}

/** Undo one step. Returns what was undone, or null if there was nothing. */
export function undo(g) {
    if (!g?.id) return null;
    flush(g);
    const s = stack(g);
    const step = s.undo.pop();
    if (!step) return null;
    s.redo.push({ state: s.last, label: step.label });
    restore(g, step.state);
    notify(g);
    return step.label;
}

/** Redo one step. Returns what was redone, or null if there was nothing. */
export function redo(g) {
    if (!g?.id) return null;
    flush(g);
    const s = stack(g);
    const step = s.redo.pop();
    if (!step) return null;
    s.undo.push({ state: s.last, label: step.label });
    restore(g, step.state);
    notify(g);
    return step.label;
}

/** What the next undo and redo would do, for button tooltips. */
export function peek(g) {
    const s = g?.id ? stacks.get(g.id) : null;
    return {
        // Typing not yet recorded is what an undo would take back first.
        undo: pending.has(g?.id) ? 'your last edit' : (s?.undo.at(-1)?.label ?? null),
        redo: s?.redo.at(-1)?.label ?? null,
    };
}

export function onHistoryChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/* ------------------------------------------------------------------ */
/* naming a step                                                       */
/* ------------------------------------------------------------------ */

const name = (n) => `"${n?.title || 'block'}"`;

/** A few words for what changed between two snapshots. */
export function describe(a, b) {
    const an = a.nodes ?? {}, bn = b.nodes ?? {};
    const aw = a.wires ?? {}, bw = b.wires ?? {};
    const added = Object.keys(bn).filter(id => !an[id]);
    const removed = Object.keys(an).filter(id => !bn[id]);
    const wiredIn = Object.keys(bw).filter(id => !aw[id]);
    const wiredOut = Object.keys(aw).filter(id => !bw[id]);
    const title = (nodes, id) => name(nodes[id]);
    const wireName = (nodes, w) => `${title(nodes, w.from)} → ${title(nodes, w.to)}`;

    if (added.length > 1 || removed.length > 1) {
        return added.length && removed.length ? 'rebuild the canvas'
            : added.length ? `add ${added.length} blocks` : `delete ${removed.length} blocks`;
    }
    const ag = a.groups ?? {}, bg = b.groups ?? {};
    const gname = (x) => `group "${x?.title || 'Group'}"`;
    const newGroup = Object.keys(bg).find(id => !ag[id]);
    const oldGroup = Object.keys(ag).find(id => !bg[id]);
    if (newGroup && !added.length && !removed.length) return `make ${gname(bg[newGroup])}`;
    if (oldGroup && !added.length && !removed.length) return `ungroup ${gname(ag[oldGroup])}`;
    for (const id of Object.keys(bg)) {
        const x = ag[id], y = bg[id];
        if (!x) continue;
        if ((x.enabled !== false) !== (y.enabled !== false)) return `switch ${y.enabled === false ? 'off' : 'on'} ${gname(y)}`;
        if (!!x.collapsed !== !!y.collapsed) return `${y.collapsed ? 'fold' : 'open'} ${gname(y)}`;
    }
    const joined = Object.keys(bn).filter(id => an[id] && (an[id].inGroup ?? '') !== (bn[id].inGroup ?? ''));
    if (joined.length === 1 && !added.length && !removed.length) {
        const y = bn[joined[0]];
        return y.inGroup ? `put ${name(y)} in ${gname(bg[y.inGroup])}` : `take ${name(y)} out of ${gname(ag[an[joined[0]].inGroup])}`;
    }
    if (added.length === 1 && !removed.length) return `add ${title(bn, added[0])}`;
    if (removed.length === 1 && !added.length) return `delete ${title(an, removed[0])}`;
    if (a.name !== b.name) return 'rename the canvas';
    if (wiredIn.length === 1 && !wiredOut.length) return `connect ${wireName(bn, bw[wiredIn[0]])}`;
    if (wiredOut.length === 1 && !wiredIn.length) return `disconnect ${wireName(an, aw[wiredOut[0]])}`;
    if (wiredIn.length || wiredOut.length) return 'rewire';

    const changed = Object.keys(bn).filter(id => an[id] && JSON.stringify(an[id]) !== JSON.stringify(bn[id]));
    const kindChanged = Object.keys(bw).filter(id => aw[id] && JSON.stringify(aw[id]) !== JSON.stringify(bw[id]));
    if (kindChanged.length && !changed.length) return 'change a wire';
    if (changed.length > 1) {
        const moved = changed.every(id => movedOnly(an[id], bn[id]));
        return moved ? `move ${changed.length} blocks` : `${changed.length} changes`;
    }
    if (changed.length === 1) {
        const id = changed[0];
        const x = an[id], y = bn[id];
        if (movedOnly(x, y)) return `move ${name(y)}`;
        if ((x.enabled !== false) !== (y.enabled !== false)) return `switch ${y.enabled === false ? 'off' : 'on'} ${name(y)}`;
        if (x.title !== y.title) return `rename ${name(x)}`;
        return `edit ${name(y)}`;
    }
    return 'change';
}

function movedOnly(x, y) {
    const { x: _x1, y: _y1, ...restA } = x;
    const { x: _x2, y: _y2, ...restB } = y;
    return (x.x !== y.x || x.y !== y.y) && JSON.stringify(restA) === JSON.stringify(restB);
}
