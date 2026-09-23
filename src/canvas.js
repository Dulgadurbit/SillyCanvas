/**
 * Prompt Canvas — the canvas renderer.
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
    NODE_TYPES, WIRE_KINDS, connect, disconnect, removeNode, touchGraph, wiresInto,
} from './state.js';

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
};

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
        this.host.style.backgroundPosition = `${v.x}px ${v.y}px`;
        this.host.style.backgroundSize = `${24 * v.zoom}px ${24 * v.zoom}px`;
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

        const head = document.createElement('div');
        head.className = 'pc-node-head';

        const badge = document.createElement('span');
        badge.className = 'pc-badge';
        badge.textContent = TYPE_LABEL[node.type] ?? node.type;

        const title = document.createElement('span');
        title.className = 'pc-node-title';
        title.textContent = node.title || 'Untitled';
        title.title = node.title || '';

        head.append(badge, title);

        if (node.type !== NODE_TYPES.OUTPUT) {
            const toggle = document.createElement('div');
            toggle.className = `pc-toggle fa-solid ${node.enabled === false ? 'fa-toggle-off' : 'fa-toggle-on'}`;
            toggle.title = node.enabled === false ? 'Switched off' : 'Switched on';
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

        if (node.condition && node.condition.mode !== 'always') {
            const cond = document.createElement('div');
            cond.className = 'pc-node-cond';
            cond.innerHTML = `<i class="fa-solid fa-code-branch"></i> ${this.#conditionLabel(node.condition)}`;
            el.append(cond);
        }

        if (node.profileId || node.type === NODE_TYPES.GENERATE) {
            const model = document.createElement('div');
            model.className = 'pc-node-model';
            const name = this.hooks.profileName?.(node.profileId) ?? null;
            const where = name ?? (node.profileId ? node.profileId : 'same connection as the chat');
            model.innerHTML = node.model
                ? `<i class="fa-solid fa-microchip"></i> ${where} \u00b7 <b>${node.model}</b>`
                : `<i class="fa-solid fa-microchip"></i> ${where}`;
            el.append(model);
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

        if (node.type !== NODE_TYPES.NOTE) {
            if (node.type !== NODE_TYPES.OUTPUT) {
                const outPort = document.createElement('div');
                outPort.className = 'pc-port pc-port-out';
                outPort.dataset.node = node.id;
                outPort.dataset.dir = 'out';
                outPort.title = node.type === NODE_TYPES.GENERATE
                    ? 'The model\u2019s reply leaves from here. It does not go back into this block.'
                    : 'Drag to wire this block into another';
                el.append(outPort);
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
        switch (c.mode) {
            case 'probability': return `${c.chance ?? 100}% of the time`;
            case 'search': return `${c.mode === 'none' ? 'unless' : 'if'} text matches`;
            case 'variable': return `if ${c.name || 'var'} ${c.op || 'eq'} ${c.value ?? ''}`;
            case 'model': return `if model ~ ${c.value || '?'}`;
            default: return c.mode;
        }
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
            case NODE_TYPES.GENERATE:
                return (node.content || '').slice(0, 180)
                    || 'Send point. What is wired in above goes to the model; the reply goes on below.';
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
            case NODE_TYPES.NOTE:
                return node.content || '';
            case NODE_TYPES.OUTPUT:
                return 'Everything wired here is sent, top to bottom.';
            default:
                return '';
        }
    }

    /** Port centre in graph coordinates. */
    #portPos(nodeId, dir) {
        const el = this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(nodeId)}"]`);
        const node = this.graph.nodes[nodeId];
        if (!node) return { x: 0, y: 0 };
        const w = node.w || 260;
        const h = el ? el.offsetHeight : 90;
        return dir === 'out'
            ? { x: node.x + w / 2, y: node.y + h }
            : { x: node.x + w / 2, y: node.y };
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

    #path(from, to) {
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

        for (const wire of Object.values(this.graph.wires)) {
            const tie = wire.kind === WIRE_KINDS.TOGETHER;

            // A tie joins two blocks side by side, because nothing flows along
            // it. Drawing it bottom-to-top like a data wire would be a lie.
            const left = tie && this.graph.nodes[wire.from] && this.graph.nodes[wire.to]
                && this.graph.nodes[wire.from].x <= this.graph.nodes[wire.to].x;
            const from = tie
                ? this.#sidePos(left ? wire.from : wire.to, 'right')
                : this.#portPos(wire.from, 'out');
            const to = tie
                ? this.#sidePos(left ? wire.to : wire.from, 'left')
                : this.#portPos(wire.to, 'in');
            const d = tie ? this.#tiePath(from, to) : this.#path(from, to);

            const hit = document.createElementNS(SVG_NS, 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('class', 'pc-wire-hit');
            hit.dataset.id = wire.id;

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', `pc-wire pc-wire-${wire.kind}${this.selection?.kind === 'wire' && this.selection.id === wire.id ? ' pc-selected' : ''}`);

            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('class', 'pc-wire-label');
            label.setAttribute('x', (from.x + to.x) / 2);
            label.setAttribute('y', (from.y + to.y) / 2);
            label.textContent = tie ? TOGETHER_LABEL : (WIRE_LABEL[wire.kind] ?? wire.kind);

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
            const wireHit = e.target.closest('.pc-wire-hit');

            if (port) {
                e.preventDefault();
                e.stopPropagation();
                const dir = port.dataset.dir;
                const nodeId = port.dataset.node;
                this.linking = {
                    dir,
                    nodeId,
                    from: dir === 'tie'
                        ? this.#sidePos(nodeId, port.dataset.side === 'left' ? 'left' : 'right')
                        : this.#portPos(nodeId, dir),
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
                return;
            }
            if (this.drag) {
                const p = this.toGraph(e.clientX, e.clientY);
                const node = this.graph.nodes[this.drag.id];
                if (!node) return;
                node.x = Math.round(p.x - this.drag.dx);
                node.y = Math.round(p.y - this.drag.dy);
                this.drag.moved = true;
                const el = this.nodeLayer.querySelector(`.pc-node[data-id="${CSS.escape(node.id)}"]`);
                if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
                this.#drawWires();

                // Dragging a block out over a library folder means "save it there".
                const under = document.elementFromPoint(e.clientX, e.clientY);
                const folder = under?.closest?.('.pc-folder[data-folder]') ?? null;
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
                const port = e.target.closest?.('.pc-port');
                const nodeEl = e.target.closest?.('.pc-node');
                const targetId = port?.dataset.node ?? nodeEl?.dataset.id ?? null;
                const link = this.linking;
                this.linking = null;
                this.host.classList.remove('pc-tying');

                if (targetId && targetId !== link.nodeId) {
                    const tie = link.dir === 'tie';
                    const fromId = (tie || link.dir === 'out') ? link.nodeId : targetId;
                    const toId = (tie || link.dir === 'out') ? targetId : link.nodeId;
                    const res = connect(this.graph, fromId, toId, tie ? WIRE_KINDS.TOGETHER : WIRE_KINDS.MERGE);
                    if (!res.ok) this.hooks.onToast?.(res.reason);
                    else this.hooks.onChange?.();
                }
                this.render();
                return;
            }
            if (this.drag) {
                const drop = this.drag;
                this.drag = null;
                this.hooks.onNodeOverFolder?.(null);

                if (drop.overFolder) {
                    const node = this.graph.nodes[drop.id];
                    if (node) {
                        node.x = drop.homeX;
                        node.y = drop.homeY;
                        this.hooks.onNodeDropOnFolder?.(node, drop.overFolder.dataset.folder);
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
            const wireHit = e.target.closest('.pc-wire-hit');
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
