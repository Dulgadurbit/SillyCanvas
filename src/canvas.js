/**
 * Silly Canvas — the canvas renderer.
 *
 * Hand-rolled on SVG plus absolutely positioned DOM, deliberately. A graph
 * library would mean either a bundler step or a CDN dependency, and neither
 * survives a SillyTavern update gracefully. This way the nodes are ordinary
 * elements that inherit your theme and respond to ordinary CSS.
 *
 * Flow is top to bottom: the out port sits on the bottom edge, the in port on
 * the top edge, and wires curve downward. Reading order follows vertical
 * position, so the picture and the prompt agree.
 */

import {
    NODE_TYPES, WIRE_KINDS, connect, disconnect, removeNode, touchGraph, wiresInto, deciderKeys,
} from './state.js?v=0.11.0';
import { selectLabel } from './select.js?v=0.11.0';

const SVG_NS = 'http://www.w3.org/2000/svg';

const WIRE_LABEL = {
    [WIRE_KINDS.MERGE]: 'merge',
    [WIRE_KINDS.APPEND]: 'append',
    [WIRE_KINDS.PREPEND]: 'prepend',
};

/** Not a data wire — a tie saying "send these two at the same time". */
const TOGETHER_LABEL = 'together';

const TYPE_LABEL = {
    [NODE_TYPES.PROMPT]: 'Prompt',
    [NODE_TYPES.ST]: 'SillyTavern',
    [NODE_TYPES.HISTORY]: 'History',
    [NODE_TYPES.INJECTION]: 'Injection',
    [NODE_TYPES.GENERATE]: 'Generate',
    [NODE_TYPES.OUTPUT]: 'Output',
    [NODE_TYPES.NOTE]: 'Note',
    [NODE_TYPES.DECIDER]: 'Decider',
    [NODE_TYPES.LOREBOOK]: 'Lorebook',
};

/** A symbol per block type, so a canvas can be read at a glance. */
const TYPE_ICON = {
    [NODE_TYPES.PROMPT]: 'fa-align-left',
    [NODE_TYPES.ST]: 'fa-book',
    [NODE_TYPES.HISTORY]: 'fa-comments',
    [NODE_TYPES.INJECTION]: 'fa-syringe',
    [NODE_TYPES.GENERATE]: 'fa-wand-magic-sparkles',
    [NODE_TYPES.OUTPUT]: 'fa-paper-plane',
    [NODE_TYPES.NOTE]: 'fa-note-sticky',
    [NODE_TYPES.DECIDER]: 'fa-code-fork',
    [NODE_TYPES.LOREBOOK]: 'fa-book-atlas',
};

/** Whether the last decision took this output. Decisions used to name one key; now a list. */
const took = (chosen, id) => Array.isArray(chosen) ? chosen.includes(id) : chosen === id;

/** A Decider's routing mode, in words. Mirrors routingMode() in compile.js. */
const ROUTING_WORDS = { all: 'every output that matches fires', first: 'the first output that matches fires', random: 'a weighted random pick', ai: 'the AI picks the outputs that apply' };
function routingOf(node) {
    if (node?.mode === null || node?.mode === '') return null;
    if (node?.mode === undefined || node.mode === 'rules') return 'first';
    return ROUTING_WORDS[node.mode] ? node.mode : 'first';
}

/** One rule, in a few words, for the face of a block. */
export function ruleLabel(c) {
    if (!c) return '';
    if (c.not) return `NOT ${ruleLabel({ ...c, not: false })}`;
    const OP = { gt: '>', lt: '<', gte: '\u2265', lte: '\u2264', eq: '=', every: 'every' };
    const terms = () => String(c.terms || '').split('\n').map(t => t.trim()).filter(Boolean);
    switch (c.mode) {
        case 'probability': return `${c.chance ?? 100}% of the time`;
        case 'search': {
            const t = terms();
            const where = { incoming: 'input', lastUser: 'user msg', lastAssistant: 'last reply', lastN: `last ${c.n || 3}`, chat: 'chat' }[c.scope || 'lastUser'] ?? '';
            if (!t.length) return 'no terms yet';
            const shown = t.slice(0, 3).map(x => `"${x}"`).join(', ') + (t.length > 3 ? ` +${t.length - 3}` : '');
            return `${c.matchMode === 'none' ? 'no' : c.matchMode === 'all' ? 'all of' : ''} ${shown} in ${where}`.trim();
        }
        case 'variable': return `${c.name || 'var'} ${c.op || 'eq'} ${c.value ?? ''}`;
        case 'model': return `model ~ ${c.value || '?'}`;
        case 'time': return `${c.from || '?'}\u2013${c.to || '?'}${Array.isArray(c.days) && c.days.length ? ' on some days' : ''}`;
        case 'chat': return c.what === 'lastSpeaker'
            ? `last speaker: ${c.value || 'user'}`
            : `${c.what === 'turn' ? 'turns' : 'messages'} ${OP[c.op || 'gte']} ${c.value ?? 0}`;
        case 'length': return `input ${OP[c.op || 'gt']} ${c.value ?? 0} ${c.unit === 'chars' ? 'chars' : 'words'}`;
        case 'character': return `character ~ ${c.value || '?'}`;
        case 'lacks': {
            const t = terms();
            if (!t.length) return 'no terms yet';
            const where = { incoming: 'input', lastUser: 'user msg', lastAssistant: 'last reply', lastN: `last ${c.n || 3}`, chat: 'chat' }[c.scope || 'incoming'] ?? '';
            return `no ${t.slice(0, 3).map(x => `"${x}"`).join(', ')}${t.length > 3 ? ` +${t.length - 3}` : ''} in ${where}`;
        }
        case 'number': {
            const SRC = { words: 'words', chars: 'chars', found: 'hits', messages: 'messages', turns: 'turns', roll: 'd100', variable: c.name || 'var' };
            return `${SRC[c.source || 'words'] ?? c.source} ${c.op === 'every' ? 'multiple of' : OP[c.op || 'gt']} ${c.value ?? 0}`;
        }
        case 'ai': {
            const q = String(c.question ?? '').trim();
            return q ? `AI says yes: "${q.length > 40 ? q.slice(0, 40) + '\u2026' : q}"` : 'no question yet';
        }
        default: return c.mode;
    }
}

export class Canvas {
    /**
     * @param {HTMLElement} host
     * @param {{onSelect?:Function, onChange?:Function, onOpen?:Function, onContextMenu?:Function}} hooks
     */
    constructor(host, hooks = {}) {
        this.host = host;
        this.hooks = hooks;
        this.graph = null;
        this.selection = null;      // {kind:'node'|'wire', id}
        this.drag = null;
        this.linking = null;
        this.trace = null;          // last compile trace, keyed by node id

        host.classList.add('pc-canvas');
        host.innerHTML = '';

        this.viewport = document.createElement('div');
        this.viewport.className = 'pc-viewport';

        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.classList.add('pc-wires');
        this.svg.setAttribute('width', '100%');
        this.svg.setAttribute('height', '100%');

        this.nodeLayer = document.createElement('div');
        this.nodeLayer.className = 'pc-nodes';

        this.viewport.append(this.svg, this.nodeLayer);
        host.append(this.viewport);

        this.#bind();
    }

    /* -------------------------------------------------------------- */
    /* view                                                            */
    /* -------------------------------------------------------------- */

    get view() {
        this.graph.view ??= { x: 0, y: 0, zoom: 1 };
        return this.graph.view;
    }

    setGraph(graph) {
        if (!graph) return;
        this.graph = graph;
        this.selection = null;
        this.render();
    }

    setTrace(trace) {
        this.trace = new Map((trace ?? []).map(t => [t.id, t]));
        this.render();
    }

    applyTransform() {
        const v = this.view;
        this.viewport.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
        // The canvas background moves and scales with the graph. Each theme
        // background has its own layers, so each gets sizes to match.
        const s = 24 * v.zoom;
        const at = `${v.x}px ${v.y}px`;
        const grid = globalThis.document?.documentElement?.dataset?.pcGrid ?? 'dots';
        if (grid === 'lines') {
            this.host.style.backgroundSize = `${s}px ${s}px, ${s}px ${s}px, ${s * 5}px ${s * 5}px, ${s * 5}px ${s * 5}px`;
            this.host.style.backgroundPosition = `${at}, ${at}, ${at}, ${at}`;
        } else if (grid === 'paper') {
            this.host.style.backgroundSize = `${s * 1.5}px ${s * 1.5}px, 100% 100%`;
            this.host.style.backgroundPosition = `${at}, 0 0`;
        } else if (grid === 'scan') {
            this.host.style.backgroundSize = `auto, 100% 100%`;
            this.host.style.backgroundPosition = `0 0, 0 0`;
        } else {
            this.host.style.backgroundSize = `${s}px ${s}px`;
            this.host.style.backgroundPosition = at;
        }
    }

    /** Screen coordinates to graph coordinates. */
    toGraph(clientX, clientY) {
        const rect = this.host.getBoundingClientRect();
        const v = this.view;
        return {
            x: (clientX - rect.left - v.x) / v.zoom,
            y: (clientY - rect.top - v.y) / v.zoom,
        };
    }

    zoomBy(factor, clientX, clientY) {
        const v = this.view;
        const next = Math.max(0.25, Math.min(2.5, v.zoom * factor));
        if (next === v.zoom) return;
        const rect = this.host.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        v.x = px - (px - v.x) * (next / v.zoom);
        v.y = py - (py - v.y) * (next / v.zoom);
        v.zoom = next;
        this.applyTransform();
        this.#drawWires();
    }

    fit() {
        const nodes = Object.values(this.graph?.nodes ?? {});
        if (!nodes.length) return;
        const pad = 80;
        const minX = Math.min(...nodes.map(n => n.x)) - pad;
        const minY = Math.min(...nodes.map(n => n.y)) - pad;
        const maxX = Math.max(...nodes.map(n => n.x + (n.w || 260))) + pad;
        const maxY = Math.max(...nodes.map(n => n.y + 160)) + pad;
        const rect = this.host.getBoundingClientRect();
        const zoom = Math.max(0.25, Math.min(1.2, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))));
        const v = this.view;
        v.zoom = zoom;
        v.x = -minX * zoom + (rect.width - (maxX - minX) * zoom) / 2;
        v.y = -minY * zoom + (rect.height - (maxY - minY) * zoom) / 2;
        this.applyTransform();
        this.#drawWires();
    }

    /* -------------------------------------------------------------- */
    /* rendering                                                       */
    /* -------------------------------------------------------------- */

    render() {
        if (!this.graph) return;
        this.applyTransform();
        this.#drawNodes();
        this.#drawWires();
        this.#applyFocus();
    }

    /**
     * What feeds a block: every block whose text ends up in it, and the wires
     * that carry it. It stops at a Generate block, because only its answer
     * travels on, not what went into it. Blocks that only switch it on
     * (Activate wires) are returned separately.
     */
    feeders(nodeId) {
        const nodes = new Set();
        const wires = new Set();
        const switches = new Set();
        const stack = [nodeId];
        const seen = new Set();
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            for (const w of Object.values(this.graph.wires)) {
                if (w.to !== id || w.kind === WIRE_KINDS.TOGETHER || w.loop) continue;
                const src = this.graph.nodes[w.from];
                if (!src) continue;
                wires.add(w.id);
                if (w.mode === 'activate') { if (!nodes.has(src.id)) switches.add(src.id); continue; }
                nodes.add(src.id);
                switches.delete(src.id);
                if (src.type !== NODE_TYPES.GENERATE) stack.push(src.id);
            }
        }
        return { nodes, wires, switches };
    }

    /** Light up what feeds the hovered block, or else the selected one. */
    #applyFocus() {
        const id = this.hoverId ?? (this.selection?.kind === 'node' ? this.selection.id : null);
        const f = id && this.graph?.nodes[id] ? this.feeders(id) : null;
        this.host.classList.toggle('pc-focusing', !!f && (f.nodes.size + f.switches.size) > 0);
        for (const el of this.nodeLayer.querySelectorAll('.pc-node')) {
            const nid = el.dataset.id;
            el.classList.toggle('pc-feeds', !!f?.nodes.has(nid));
            el.classList.toggle('pc-switches', !!f?.switches.has(nid));
            el.classList.toggle('pc-focus', !!f && nid === id);
        }
        for (const p of this.svg.querySelectorAll('path.pc-wire')) {
            p.classList.toggle('pc-wire-feeds', !!f?.wires.has(p.dataset.id));
        }
    }

    /** Hovering a block shows what feeds it. */
    setHover(id) {
        if (this.hoverId === id) return;
        this.hoverId = id;
        this.#applyFocus();
    }

    /** Nodes with a path to Output. Anything else is decoration. */
    #reaching() {
        const out = Object.values(this.graph.nodes).find(n => n.type === NODE_TYPES.OUTPUT);
        const seen = new Set();
        if (!out) return seen;
        const stack = [out.id];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            for (const w of Object.values(this.graph.wires)) {
                if (w.to === id) stack.push(w.from);
            }
        }
        return seen;
    }

    #drawNodes() {
        const frag = document.createDocumentFragment();
        this.reaching = this.#reaching();
        const nodes = Object.values(this.graph.nodes)
            .sort((a, b) => (a.y - b.y) || (a.x - b.x));

        for (const node of nodes) {
            frag.append(this.#nodeElement(node));
        }
        this.nodeLayer.innerHTML = '';
        this.nodeLayer.append(frag);
    }

    #nodeElement(node) {
        const el = document.createElement('div');
        el.className = `pc-node pc-node-${node.type}`;
        el.dataset.id = node.id;
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        el.style.width = `${node.w || 260}px`;
        if (node.enabled === false) el.classList.add('pc-off');
        if (node.type !== NODE_TYPES.NOTE && node.type !== NODE_TYPES.OUTPUT
            && this.reaching && !this.reaching.has(node.id)) {
            el.classList.add('pc-stranded');
            el.title = 'Not wired through to Output, so this block does nothing.';
        }
        if (this.selection?.kind === 'node' && this.selection.id === node.id) el.classList.add('pc-selected');

        const t = this.trace?.get(node.id);
        if (t) el.classList.add(`pc-trace-${t.status}`);
        el.addEventListener('mouseenter', () => this.setHover(node.id));
        el.addEventListener('mouseleave', () => { if (this.hoverId === node.id) this.setHover(null); });

        const head = document.createElement('div');
        head.className = 'pc-node-head';

        const badge = document.createElement('span');
        badge.className = 'pc-badge';
        const icon = document.createElement('i');
        icon.className = `fa-solid ${TYPE_ICON[node.type] ?? 'fa-square'} pc-badge-icon`;
        badge.append(icon, ` ${TYPE_LABEL[node.type] ?? node.type}`);

        const title = document.createElement('span');
        title.className = 'pc-node-title';
        title.textContent = node.title || 'Untitled';
        title.title = node.title || '';

        head.append(badge, title);
        // Roughly how much of the prompt this block is, from the last preview.
        if (t?.chars && t.status === 'in') {
            const tok = document.createElement('span');
            tok.className = 'pc-tok';
            const n = Math.ceil(t.chars / 4);
            tok.textContent = n >= 1000 ? `\u2248${(n / 1000).toFixed(1)}k tok` : `\u2248${n} tok`;
            tok.title = 'About how many tokens this block adds (its own text, from the last preview)';
            head.append(tok);
        }
        if (node.enabled === false) {
            const off = document.createElement('span');
            off.className = 'pc-off-pill';
            off.textContent = 'OFF';
            off.title = 'This block is switched off. Its own text is not sent; anything wired through it still passes.';
            head.append(off);
        }

        if (node.type !== NODE_TYPES.OUTPUT) {
            const toggle = document.createElement('div');
            toggle.className = `pc-toggle fa-solid ${node.enabled === false ? 'fa-toggle-off pc-toggle-off' : 'fa-toggle-on pc-toggle-on'}`;
            toggle.title = node.enabled === false ? 'Switched off \u2014 click to switch on' : 'Switched on \u2014 click to switch off';
            toggle.addEventListener('mousedown', e => e.stopPropagation());
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                node.enabled = node.enabled === false;
                touchGraph(this.graph);
                this.render();
                this.hooks.onChange?.();
            });
            head.append(toggle);
        }

        const body = document.createElement('div');
        body.className = 'pc-node-body';
        body.textContent = this.#preview(node);

        el.append(head, body);

        if (node.type === NODE_TYPES.DECIDER) {
            body.remove();
            const list = document.createElement('div');
            list.className = 'pc-dec-keys';
            const chosen = this.trace?.get(node.id)?.decision ?? null;
            const keys = deciderKeys(node);
            const routing = routingOf(node);
            const mode = document.createElement('div');
            mode.className = `pc-dec-mode${routing ? '' : ' pc-dec-unset'}`;
            mode.textContent = routing ? ROUTING_WORDS[routing] : 'Not set up yet \u2014 select it and choose how it routes';
            list.append(mode);
            if (routing === 'random') {
                const total = keys.reduce((n, k) => n + Math.max(0, Number(k.weight ?? 1)), 0) || 1;
                for (const k of keys) list.append(this.#keyRow(k, `${Math.round(100 * Math.max(0, Number(k.weight ?? 1)) / total)}%`, took(chosen, k.id)));
            } else if (routing) {
                for (const k of node.keys ?? []) {
                    let say;
                    if (routing === 'ai') {
                        const d = String(k.description ?? '').trim();
                        say = d ? (d.length > 60 ? d.slice(0, 60) + '\u2026' : d) : 'no description yet';
                    } else {
                        const rules = (k.conditions ?? []).map(ruleLabel).filter(Boolean);
                        const join = k.match === 'all' ? ' and ' : ' or ';
                        say = rules.length ? `if ${rules.join(join)}` : 'no rules yet';
                    }
                    list.append(this.#keyRow(k, say, took(chosen, k.id)));
                }
                if (node.fallback) list.append(this.#keyRow(node.fallback, 'when nothing else fires', took(chosen, node.fallback.id), true));
            }
            el.append(list);

            // "?" opens the guide.
            const help = document.createElement('div');
            help.className = 'pc-help fa-solid fa-circle-question';
            help.title = 'How Deciders work';
            help.addEventListener('mousedown', e => e.stopPropagation());
            help.addEventListener('click', (e) => { e.stopPropagation(); this.hooks.onHelp?.(node); });
            head.insertBefore(help, head.querySelector('.pc-toggle'));
        }

        if (node.type !== NODE_TYPES.DECIDER && node.condition && node.condition.mode !== 'always') {
            const cond = document.createElement('div');
            cond.className = 'pc-node-cond';
            cond.innerHTML = `<i class="fa-solid fa-code-branch"></i> ${this.#conditionLabel(node.condition)}`;
            el.append(cond);
        }

        if (node.profileId || node.type === NODE_TYPES.GENERATE) {
            const model = document.createElement('div');
            model.className = 'pc-node-model';
            const name = this.hooks.profileName?.(node.profileId) ?? null;
            const where = name ?? (node.profileId ? node.profileId : 'same as the chat');
            const actual = node.type === NODE_TYPES.GENERATE ? (this.hooks.effectiveModel?.(node) ?? node.model) : node.model;
            model.innerHTML = actual
                ? `<i class="fa-solid fa-microchip"></i> ${where} \u00b7 <b>${actual}</b>`
                : `<i class="fa-solid fa-microchip"></i> ${where}`;
            model.title = node.model ? 'This block\u2019s own model.' : node.profileId ? 'The model this connection profile uses.' : 'Follows whatever model the chat is using right now.';
            el.append(model);
        }

        if (node.type === NODE_TYPES.GENERATE && Number(node.repeat) > 1) {
            const rep = document.createElement('div');
            rep.className = 'pc-node-repeat';
            rep.innerHTML = `<i class="fa-solid fa-repeat"></i> up to ${Math.min(10, Math.round(node.repeat))} passes${node.repeatStopWhenSame !== false ? ', stops when nothing changes' : ''}`;
            el.append(rep);
        }

        if (node.type === NODE_TYPES.GENERATE) {
            const wave = this.hooks.waveInfo?.(node);
            if (wave && wave.total > 1) {
                const tag = document.createElement('div');
                tag.className = `pc-node-wave${wave.willRunTogether ? '' : ' pc-node-wave-off'}`;
                if (!wave.siblings.length) {
                    tag.innerHTML = `<i class="fa-solid fa-arrow-down-1-9"></i> wave ${wave.wave} of ${wave.waves} \u00b7 waits for the wave before`;
                    tag.title = 'This waits, because a Generate block upstream feeds it.';
                } else if (wave.willRunTogether) {
                    tag.innerHTML = `<i class="fa-solid fa-bolt"></i> ${wave.tied ? 'tied to' : 'at the same time as'} ${wave.siblings.join(', ')}`;
                    tag.title = wave.tied
                        ? 'You tied these, so they go out together whatever the setting says.'
                        : 'These go out together because nothing wires one into another.';
                } else {
                    tag.innerHTML = `<i class="fa-solid fa-bolt-slash"></i> could go out with ${wave.siblings.join(', ')} \u2014 sending one at a time`;
                    tag.title = 'Parallel sending is switched off. Tie these blocks, or switch it on in the status bar.';
                }
                el.append(tag);
            }
        }

        const copies = this.hooks.copiesOf?.(node) ?? 1;
        if (copies > 1) {
            const dup = document.createElement('div');
            dup.className = 'pc-node-dup';
            dup.innerHTML = `<i class="fa-solid fa-clone"></i> sent ${copies}\u00d7 \u2014 reaches Output down ${copies} paths`;
            dup.title = 'This block\u2019s text lands in the prompt more than once. Usually a wiring surprise rather than something you wanted.';
            el.append(dup);
        }

        if (node.type === NODE_TYPES.ST && node.override?.content !== undefined) {
            const badge = document.createElement('div');
            badge.className = 'pc-node-cond pc-node-override';
            badge.innerHTML = '<i class="fa-solid fa-pen"></i> edited on this canvas';
            el.append(badge);
        }

        if (node.type === NODE_TYPES.DECIDER) {
            const keys = deciderKeys(node);
            const chosen = this.trace?.get(node.id)?.decision ?? null;
            keys.forEach((k, i) => {
                const port = document.createElement('div');
                port.className = `pc-port pc-port-out pc-port-key${took(chosen, k.id) ? ' pc-port-chosen' : ''}${k === node.fallback ? ' pc-port-fallback' : ''}`;
                port.dataset.node = node.id;
                port.dataset.dir = 'out';
                port.dataset.port = k.id;
                port.style.left = `${100 * (i + 1) / (keys.length + 1)}%`;
                port.title = `Drag to wire the "${k.name}" path`;
                const tag = document.createElement('span');
                tag.className = 'pc-port-keyname';
                tag.textContent = k.name || 'key';
                port.append(tag);
                el.append(port);
            });
        }

        if (node.type !== NODE_TYPES.NOTE) {
            if (node.type !== NODE_TYPES.OUTPUT && node.type !== NODE_TYPES.DECIDER) {
                const outPort = document.createElement('div');
                outPort.className = 'pc-port pc-port-out';
                outPort.dataset.node = node.id;
                outPort.dataset.dir = 'out';
                outPort.title = node.type === NODE_TYPES.GENERATE
                    ? 'The model\u2019s reply leaves from here. It does not go back into this block.'
                    : 'Drag to wire this block into another';
                el.append(outPort);

                // The whole bottom edge is a handle too, so starting a wire
                // does not mean hunting for a 13px dot.
                const strip = document.createElement('div');
                strip.className = 'pc-port pc-port-strip';
                strip.dataset.node = node.id;
                strip.dataset.dir = 'out';
                strip.title = 'Drag from the bottom edge to wire this block into another';
                el.append(strip);
            }
            const inPort = document.createElement('div');
            inPort.className = 'pc-port pc-port-in';
            inPort.dataset.node = node.id;
            inPort.dataset.dir = 'in';
            inPort.title = node.type === NODE_TYPES.GENERATE
                ? 'Everything wired in here is the question sent to the model'
                : 'What comes in here is read before this block\u2019s own text';
            el.append(inPort);

            // Generate blocks get a third port on the side. Nothing flows
            // through it: dragging it to another Generate block says "send
            // these two at the same time".
            if (node.type === NODE_TYPES.GENERATE) {
                for (const side of ['right', 'left']) {
                    const tiePort = document.createElement('div');
                    tiePort.className = `pc-port pc-port-tie pc-port-tie-${side}`;
                    tiePort.dataset.node = node.id;
                    tiePort.dataset.dir = 'tie';
                    tiePort.dataset.side = side;
                    tiePort.title = 'Drag to another Generate block to send them at the same time';
                    tiePort.innerHTML = '<i class="fa-solid fa-bolt"></i>';
                    el.append(tiePort);
                }
            }
        }

        return el;
    }

    #conditionLabel(c) {
        return c.mode === 'probability' ? ruleLabel(c) : `if ${ruleLabel(c)}`;
    }

    #preview(node) {
        switch (node.type) {
            case NODE_TYPES.PROMPT:
                return (node.content || '').slice(0, 180) || 'Empty prompt';
            case NODE_TYPES.ST: {
                if (!node.identifier) return 'No prompt chosen';
                if (node.override?.content !== undefined) {
                    return String(node.override.content).slice(0, 180) || 'Overridden, and empty';
                }
                const text = this.hooks.stPreview?.(node) ?? '';
                if (text) return String(text).slice(0, 180);
                return 'Nothing in it right now';
            }
            case NODE_TYPES.GENERATE: {
                // Say how the question is put together, so the order is
                // visible without opening the block.
                const own = String(node.content ?? '').trim();
                const inputs = Object.values(this.graph.wires)
                    .filter(w => w.to === node.id && w.kind !== WIRE_KINDS.TOGETHER && !w.loop)
                    .map(w => this.graph.nodes[w.from]).filter(Boolean)
                    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
                const n = inputs.length;
                const wired = `${n} wired block${n === 1 ? '' : 's'}`;
                if (!own && !n) return 'Nothing to ask yet. Wire blocks in above, or write an instruction.';
                if (!own) return `${wired}. The last one, "${inputs[n - 1].title}", is the instruction.`;
                const text = `"${own.slice(0, 140)}${own.length > 140 ? '\u2026' : ''}"`;
                if (!n) return text;
                return node.contentPosition === 'before' ? `${text}, then ${wired}` : `${wired}, then ${text}`;
            }
            case NODE_TYPES.HISTORY: {
                const span = node.count > 0
                    ? `Last ${node.count} messages${node.skip ? `, skipping ${node.skip}` : ''}`
                    : 'Whole chat';
                return node.format === 'prose'
                    ? `${span}, as prose${node.nameStyle && node.nameStyle !== 'none' ? ` with ${node.nameStyle} labels` : ' with no speaker labels'}`
                    : `${span}, as turns`;
            }
            case NODE_TYPES.INJECTION:
                return (node.sources || []).join(', ') || 'Nothing selected';
            case NODE_TYPES.LOREBOOK: {
                const src = node.sources ?? {};
                const from = [src.chat && 'chat', src.character && 'character', src.persona && 'persona', src.global && 'global']
                    .filter(Boolean).concat((node.books ?? []).map(b => `"${b}"`));
                const how = {
                    st: 'as SillyTavern would',
                    scan: node.scanFrom === 'chat' ? `keys in the last ${node.scanDepth || 4} messages` : 'keys in the text wired in',
                    all: 'every entry', constant: 'constant entries', picked: `${(node.picked ?? []).length} picked entries`,
                }[node.mode ?? 'st'];
                const bits = [how];
                if (node.memoryOnly) bits.push('Memory Books only');
                if (Number(node.maxEntries) > 0) bits.push(`max ${node.maxEntries}`);
                if (Number(node.tokenBudget) > 0) bits.push(`\u2264${node.tokenBudget} tok`);
                if (node.excludeFromWI) bits.push('kept out of World Info');
                return `${from.length ? from.join(' + ') : 'no lorebooks chosen'} \u00b7 ${bits.join(' \u00b7 ')}`;
            }
            case NODE_TYPES.NOTE:
                return node.content || '';
            case NODE_TYPES.OUTPUT:
                return 'Everything wired here is sent, top to bottom.';
            case NODE_TYPES.DECIDER:
                return '';
            default:
                return '';
        }
    }

    #nodeEl(id) {
        return id ? this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(id)}"]`) : null;
    }

    /**
     * Which block a wire being drawn would connect to: the block under the
     * pointer (anywhere on it, not just its port), or failing that the
     * nearest port within a generous reach, so a near miss still lands.
     */
    #linkTarget(e) {
        const link = this.linking;
        if (!link) return null;
        const under = document.elementFromPoint?.(e.clientX, e.clientY) ?? e.target;
        const hit = under?.closest?.('.pc-port')?.dataset.node ?? under?.closest?.('.pc-node')?.dataset.id ?? null;
        if (hit && hit !== link.nodeId) return hit;

        const p = this.toGraph(e.clientX, e.clientY);
        const reach = 36 / (this.view?.zoom || 1);
        let best = null, bestD = reach;
        for (const n of Object.values(this.graph.nodes)) {
            if (n.id === link.nodeId || n.type === NODE_TYPES.NOTE) continue;
            if (link.dir === 'tie' && n.type !== NODE_TYPES.GENERATE) continue;
            const q = link.dir === 'tie'
                ? this.#sidePos(n.id, p.x < n.x + (n.w || 260) / 2 ? 'left' : 'right')
                : link.dir === 'in' && n.type === NODE_TYPES.DECIDER
                    ? this.#portPos(n.id, 'out', this.#nearestKey(n.id, p))
                    : this.#portPos(n.id, link.dir === 'out' ? 'in' : 'out');
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (d < bestD) { bestD = d; best = n.id; }
        }
        return best;
    }

    #keyRow(k, rule, chosen, fallback = false) {
        const row = document.createElement('div');
        row.className = `pc-dec-key${chosen ? ' pc-dec-chosen' : ''}${fallback ? ' pc-dec-fallback' : ''}`;
        const name = document.createElement('b');
        name.textContent = k.name || 'key';
        const why = document.createElement('span');
        why.textContent = rule;
        row.append(name, why);
        return row;
    }

    /** Port centre in graph coordinates. A Decider has one out port per key. */
    #portPos(nodeId, dir, portId = null) {
        const el = this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(nodeId)}"]`);
        const node = this.graph.nodes[nodeId];
        if (!node) return { x: 0, y: 0 };
        const w = node.w || 260;
        const h = el ? el.offsetHeight : 90;
        if (dir === 'out' && node.type === NODE_TYPES.DECIDER) {
            const keys = deciderKeys(node);
            const i = Math.max(0, keys.findIndex(k => k.id === portId));
            return { x: node.x + w * (i + 1) / (keys.length + 1), y: node.y + h };
        }
        return dir === 'out'
            ? { x: node.x + w / 2, y: node.y + h }
            : { x: node.x + w / 2, y: node.y };
    }

    /** The Decider key whose port is nearest a point, for a drop that did not name one. */
    #nearestKey(nodeId, p) {
        const node = this.graph.nodes[nodeId];
        let best = null, bestD = Infinity;
        for (const k of deciderKeys(node)) {
            const q = this.#portPos(nodeId, 'out', k.id);
            const d = Math.abs(q.x - p.x);
            if (d < bestD) { bestD = d; best = k.id; }
        }
        return best;
    }

    /** Middle of a node's left or right edge, in graph coordinates. */
    #sidePos(nodeId, side) {
        const el = this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(nodeId)}"]`);
        const node = this.graph.nodes[nodeId];
        if (!node) return { x: 0, y: 0 };
        const w = node.w || 260;
        const h = el ? el.offsetHeight : 90;
        return { x: side === 'right' ? node.x + w : node.x, y: node.y + h / 2 };
    }

    /** A flat tie between two blocks that simply go out at the same time. */
    #tiePath(a, b) {
        const dx = Math.max(40, Math.abs(b.x - a.x) * 0.4);
        return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    }

    /**
     * A loop goes back up the canvas. Drawn out to the side and round, so it
     * never lies on top of the wires it is looping over.
     */
    #loopSide(from, to, wire = null) {
        // Clear the right-hand edge of both blocks it joins.
        const a = wire && this.graph.nodes[wire.from], b = wire && this.graph.nodes[wire.to];
        const edge = Math.max(from.x, to.x, a ? a.x + (a.w || 260) : 0, b ? b.x + (b.w || 260) : 0);
        return { x: edge + 36 + Math.min(80, Math.abs(from.y - to.y) * 0.08), y: (from.y + to.y) / 2 };
    }

    #loopPath(from, to, wire) {
        const s = this.#loopSide(from, to, wire);
        const down = from.y + 36, up = to.y - 36;
        return `M ${from.x} ${from.y} C ${from.x} ${down + 20}, ${s.x} ${down + 20}, ${s.x} ${down} `
            + `L ${s.x} ${up} C ${s.x} ${up - 20}, ${to.x} ${up - 20}, ${to.x} ${to.y}`;
    }

    #path(from, to) {
        // Right-angled wires, for themes that ask for them: down, across,
        // down, with small rounded turns (none on sharp themes).
        const look = globalThis.document?.documentElement?.dataset ?? {};
        if (look.pcWires === 'angled' && to.y - from.y > 30) {
            const r = look.pcShape === 'sharp' ? 0 : Math.min(10, Math.abs(to.x - from.x) / 2, (to.y - from.y) / 4);
            const mid = from.y + (to.y - from.y) / 2;
            if (Math.abs(to.x - from.x) < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
            const dir = to.x > from.x ? 1 : -1;
            return `M ${from.x} ${from.y} L ${from.x} ${mid - r} Q ${from.x} ${mid} ${from.x + dir * r} ${mid} `
                + `L ${to.x - dir * r} ${mid} Q ${to.x} ${mid} ${to.x} ${mid + r} L ${to.x} ${to.y}`;
        }
        const dy = Math.max(40, Math.abs(to.y - from.y) * 0.5);
        return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy}, ${to.x} ${to.y - dy}, ${to.x} ${to.y}`;
    }

    #drawWires() {
        if (!this.graph) return;
        this.svg.innerHTML = '';

        const bounds = { w: 4000, h: 4000 };
        for (const n of Object.values(this.graph.nodes)) {
            bounds.w = Math.max(bounds.w, n.x + 800);
            bounds.h = Math.max(bounds.h, n.y + 800);
        }
        this.svg.setAttribute('viewBox', `0 0 ${bounds.w} ${bounds.h}`);
        this.svg.setAttribute('width', bounds.w);
        this.svg.setAttribute('height', bounds.h);
        // An arrowhead for loop wires, so it is clear which way they run.
        this.svg.insertAdjacentHTML('beforeend', `<defs><marker id="pc-loop-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="pc-loop-arrow"/></marker></defs>`);

        for (const wire of Object.values(this.graph.wires)) {
            const tie = wire.kind === WIRE_KINDS.TOGETHER;

            // A tie joins two blocks side by side, because nothing flows along
            // it. Drawing it bottom-to-top like a data wire would be a lie.
            const left = tie && this.graph.nodes[wire.from] && this.graph.nodes[wire.to]
                && this.graph.nodes[wire.from].x <= this.graph.nodes[wire.to].x;
            const from = tie
                ? this.#sidePos(left ? wire.from : wire.to, 'right')
                : this.#portPos(wire.from, 'out', wire.port ?? null);
            const to = tie
                ? this.#sidePos(left ? wire.to : wire.from, 'left')
                : this.#portPos(wire.to, 'in');
            const d = tie ? this.#tiePath(from, to) : wire.loop ? this.#loopPath(from, to, wire) : this.#path(from, to);

            const hit = document.createElementNS(SVG_NS, 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('class', 'pc-wire-hit');
            hit.dataset.id = wire.id;

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            path.dataset.id = wire.id;
            const srcNode = this.graph.nodes[wire.from];
            const isKey = srcNode?.type === NODE_TYPES.DECIDER;
            const chosen = isKey ? this.trace?.get(wire.from)?.decision : undefined;
            const untaken = isKey && chosen !== undefined && chosen !== null && !took(chosen, wire.port);
            const offWire = this.graph.nodes[wire.from]?.enabled === false || this.graph.nodes[wire.to]?.enabled === false;
            const mode = !tie && (wire.mode === 'activate' || wire.mode === 'result') ? wire.mode : null;
            path.setAttribute('class', `pc-wire pc-wire-${wire.kind}${mode ? ` pc-wire-mode-${mode}` : ''}${wire.loop ? ' pc-wire-loop' : ''}${isKey ? ' pc-wire-key' : ''}${untaken ? ' pc-wire-untaken' : ''}${offWire ? ' pc-wire-off' : ''}${this.selection?.kind === 'wire' && this.selection.id === wire.id ? ' pc-selected' : ''}`);

            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('class', 'pc-wire-label');
            const side = wire.loop ? this.#loopSide(from, to, wire) : null;
            label.setAttribute('x', side ? side.x + 10 : (from.x + to.x) / 2);
            label.setAttribute('y', side ? side.y + 4 : (from.y + to.y) / 2);
            const keyName = isKey ? (deciderKeys(srcNode).find(k => k.id === wire.port)?.name ?? 'key') : null;
            label.textContent = tie ? TOGETHER_LABEL
                : wire.loop ? `\u21ba ${keyName ? keyName + ' \u00b7 ' : ''}${wire.loop.max ?? 3}\u00d7 max`
                // The output's name is already on its dot, so a mode wire just says what it does.
                : mode === 'activate' ? '\u26a1 activate'
                : mode === 'result' ? `\u2192 ${srcNode?.type === NODE_TYPES.LOREBOOK ? 'entry names' : wire.result === 'matched' ? 'matched words' : 'result'}`
                : keyName ?? (WIRE_LABEL[wire.kind] ?? wire.kind);
            if (wire.loop) {
                label.classList.add('pc-wire-label-loop');
                label.dataset.id = wire.id;
                label.setAttribute('text-anchor', 'start');
                const tip = document.createElementNS(SVG_NS, 'title');
                tip.textContent = 'Loop: runs this section again, at most this many times. Click to change.';
                label.append(tip);
                path.setAttribute('marker-end', 'url(#pc-loop-arrow)');
            }
            const filter = !tie && !wire.loop && !mode ? selectLabel(wire.select) : '';
            if (filter) {
                // The filter is the thing you most need to see: what actually crosses.
                label.textContent += ` \u00b7 ${filter}`;
                label.classList.add('pc-wire-label-filter');
            }

            this.svg.append(hit, path, label);
        }

        if (this.linking?.ghost) {
            const tie = this.linking.dir === 'tie';
            const ghost = document.createElementNS(SVG_NS, 'path');
            ghost.setAttribute('d', tie
                ? this.#tiePath(this.linking.from, this.linking.ghost)
                : this.#path(this.linking.from, this.linking.ghost));
            ghost.setAttribute('class', `pc-wire pc-wire-ghost${tie ? ' pc-wire-ghost-tie' : ''}`);
            this.svg.append(ghost);
        }
    }

    /* -------------------------------------------------------------- */
    /* interaction                                                     */
    /* -------------------------------------------------------------- */

    #bind() {
        const host = this.host;

        host.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
        }, { passive: false });

        host.addEventListener('mousedown', (e) => {
            if (!this.graph) return;
            const port = e.target.closest('.pc-port');
            const nodeEl = e.target.closest('.pc-node');
            const wireHit = e.target.closest('.pc-wire-hit') ?? e.target.closest('.pc-wire-label-loop');

            if (port) {
                e.preventDefault();
                e.stopPropagation();
                const dir = port.dataset.dir;
                const nodeId = port.dataset.node;
                let key = port.dataset.port ?? null;
                if (dir === 'out' && !key && this.graph.nodes[nodeId]?.type === NODE_TYPES.DECIDER) {
                    key = this.#nearestKey(nodeId, this.toGraph(e.clientX, e.clientY));
                }
                this.linking = {
                    dir,
                    nodeId,
                    port: key,
                    from: dir === 'tie'
                        ? this.#sidePos(nodeId, port.dataset.side === 'left' ? 'left' : 'right')
                        : this.#portPos(nodeId, dir, key),
                    ghost: this.toGraph(e.clientX, e.clientY),
                };
                this.host.classList.toggle('pc-tying', dir === 'tie');
                this.#drawWires();
                return;
            }

            if (nodeEl && e.button === 0) {
                const id = nodeEl.dataset.id;
                const node = this.graph.nodes[id];
                this.select({ kind: 'node', id });
                if (e.target.closest('.pc-toggle')) return;
                const start = this.toGraph(e.clientX, e.clientY);
                this.drag = {
                    id,
                    dx: start.x - node.x,
                    dy: start.y - node.y,
                    homeX: node.x,
                    homeY: node.y,
                    moved: false,
                    overFolder: null,
                };
                return;
            }

            if (wireHit) {
                this.select({ kind: 'wire', id: wireHit.dataset.id });
                return;
            }

            if (e.button === 0 || e.button === 1) {
                this.select(null);
                const v = this.view;
                this.pan = { x: e.clientX - v.x, y: e.clientY - v.y };
                host.classList.add('pc-panning');
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (this.linking) {
                this.linking.ghost = this.toGraph(e.clientX, e.clientY);
                this.#drawWires();
                // Light up the block the wire would land on, so you can see
                // the drop will take before you let go.
                const target = this.#linkTarget(e);
                if (target !== this.linking.hover) {
                    this.#nodeEl(this.linking.hover)?.classList.remove('pc-link-target');
                    this.linking.hover = target;
                    this.#nodeEl(target)?.classList.add('pc-link-target');
                }
                return;
            }
            if (this.drag) {
                const p = this.toGraph(e.clientX, e.clientY);
                const node = this.graph.nodes[this.drag.id];
                if (!node) return;
                node.x = Math.round(p.x - this.drag.dx);
                node.y = Math.round(p.y - this.drag.dy);
                if (!this.drag.moved) this.hooks.onDragBlock?.(true);
                this.drag.moved = true;
                const el = this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(node.id)}"]`);
                if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
                this.#drawWires();

                // Dragging a block out over the library means "save it there":
                // into the folder under the pointer, or the first folder when
                // it is dropped anywhere else on the library.
                const under = document.elementFromPoint(e.clientX, e.clientY);
                const folder = under?.closest?.('.pc-folder[data-folder]:not([data-folder=""])')
                    ?? under?.closest?.('.pc-sidebar') ?? null;
                if (folder !== this.drag.overFolder) {
                    this.drag.overFolder = folder;
                    this.hooks.onNodeOverFolder?.(folder);
                }
                return;
            }
            if (this.pan) {
                const v = this.view;
                v.x = e.clientX - this.pan.x;
                v.y = e.clientY - this.pan.y;
                this.applyTransform();
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (this.linking) {
                const targetId = this.#linkTarget(e);
                const link = this.linking;
                this.#nodeEl(link.hover)?.classList.remove('pc-link-target');
                this.linking = null;
                this.host.classList.remove('pc-tying');

                if (targetId && targetId !== link.nodeId) {
                    const tie = link.dir === 'tie';
                    const fromId = (tie || link.dir === 'out') ? link.nodeId : targetId;
                    const toId = (tie || link.dir === 'out') ? targetId : link.nodeId;
                    let port = link.dir === 'out' ? link.port : null;
                    if (link.dir === 'in' && this.graph.nodes[fromId]?.type === NODE_TYPES.DECIDER) {
                        // Dragged up from a block onto a Decider: use the key nearest where it landed.
                        port = this.#nearestKey(fromId, this.toGraph(e.clientX, e.clientY));
                    }
                    const res = connect(this.graph, fromId, toId, tie ? WIRE_KINDS.TOGETHER : WIRE_KINDS.MERGE, { port });
                    if (!res.ok) this.hooks.onToast?.(res.reason);
                    else {
                        this.hooks.onChange?.();
                        // A new loop: show its settings, so the limit is seen and can be changed.
                        if (res.wire?.loop) { this.render(); this.select({ kind: 'wire', id: res.wire.id }); return; }
                    }
                }
                this.render();
                return;
            }
            if (this.drag) {
                const drop = this.drag;
                this.drag = null;
                this.hooks.onNodeOverFolder?.(null);
                if (drop.moved) this.hooks.onDragBlock?.(false);

                if (drop.overFolder) {
                    const node = this.graph.nodes[drop.id];
                    if (node) {
                        node.x = drop.homeX;
                        node.y = drop.homeY;
                        this.hooks.onNodeDropOnFolder?.(node, drop.overFolder.dataset.folder || null);
                    }
                } else if (drop.moved) {
                    touchGraph(this.graph);
                    this.hooks.onChange?.();
                }
                this.render();
            }
            if (this.pan) {
                this.pan = null;
                this.host.classList.remove('pc-panning');
                touchGraph(this.graph);
            }
        });

        host.addEventListener('dblclick', (e) => {
            const nodeEl = e.target.closest('.pc-node');
            if (nodeEl) {
                this.hooks.onOpen?.(this.graph.nodes[nodeEl.dataset.id]);
                return;
            }
            const wireHit = e.target.closest('.pc-wire-hit');
            if (wireHit) { this.cycleWire(wireHit.dataset.id); return; }
            this.hooks.onCreateAt?.(this.toGraph(e.clientX, e.clientY));
        });

        host.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const nodeEl = e.target.closest('.pc-node');
            const wireHit = e.target.closest('.pc-wire-hit') ?? e.target.closest('.pc-wire-label-loop');
            this.hooks.onContextMenu?.({
                event: e,
                node: nodeEl ? this.graph.nodes[nodeEl.dataset.id] : null,
                wire: wireHit ? this.graph.wires[wireHit.dataset.id] : null,
                at: this.toGraph(e.clientX, e.clientY),
            });
        });

        host.addEventListener('dragover', (e) => { e.preventDefault(); });
        host.addEventListener('drop', (e) => {
            e.preventDefault();
            const raw = e.dataTransfer?.getData('application/x-prompt-canvas');
            if (!raw) return;
            try {
                this.hooks.onDrop?.(JSON.parse(raw), this.toGraph(e.clientX, e.clientY));
            } catch { /* not ours */ }
        });
    }

    select(sel) {
        this.selection = sel;
        this.render();
        this.hooks.onSelect?.(sel
            ? (sel.kind === 'node' ? this.graph.nodes[sel.id] : this.graph.wires[sel.id])
            : null, sel?.kind ?? null);
    }

    cycleWire(wireId) {
        const wire = this.graph.wires[wireId];
        if (!wire) return;
        if (wire.kind === WIRE_KINDS.TOGETHER) {
            this.hooks.onToast?.('That is a "send together" tie. Nothing flows along it, so there is nothing to cycle.');
            return;
        }
        if (wire.loop) { this.select({ kind: 'wire', id: wireId }); return; }
        const order = [WIRE_KINDS.MERGE, WIRE_KINDS.APPEND, WIRE_KINDS.PREPEND];
        wire.kind = order[(order.indexOf(wire.kind) + 1) % order.length];
        touchGraph(this.graph);
        this.render();
        this.hooks.onChange?.();
    }

    setWireKind(wireId, kind) {
        const wire = this.graph.wires[wireId];
        if (!wire) return;
        wire.kind = kind;
        touchGraph(this.graph);
        this.render();
        this.hooks.onChange?.();
    }

    deleteSelection() {
        if (!this.selection) return;
        if (this.selection.kind === 'wire') disconnect(this.graph, this.selection.id);
        else removeNode(this.graph, this.selection.id);
        this.selection = null;
        this.render();
        this.hooks.onChange?.();
    }
}

export { WIRE_LABEL, TYPE_LABEL };
