// Groups as blankets: an open group is a sheet; what rests on it is in the
// group. Blocks dropped on it join, dragged off leave; folding gathers what
// is on it. A switched-off group sends nothing and lets nothing through.
// And the Lorebook block's own "group" filter is left alone.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="host"></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent });
dom.window.document.elementFromPoint = () => null;
const { installMock } = await import('./mock.js');
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { Canvas } = await import(`../src/canvas.js?v=${v}`);
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const R = await import(`../src/run.js?v=${v}`);

const n = (id, type, x, y, extra = {}) => ({ ...S.defaultNode(type, x, y), id, title: id, ...extra });
const graph = { id: 'g', nodes: {
    sys: n('sys', 'prompt', 0, 0, { content: 'SYS' }),
    a: n('a', 'prompt', 0, 200, { content: 'A' }),
    b: n('b', 'prompt', 300, 200, { content: 'B' }),
    gen: n('gen', 'generate', 0, 400),
    lore: n('lore', 'lorebook', 700, 200, { group: 'Tavern' }),
    out: n('out', 'output', 0, 700),
}, wires: {}, view: { x: 0, y: 0, zoom: 1 } };
for (const [f, t] of [['sys', 'out'], ['a', 'out'], ['b', 'gen'], ['gen', 'out']]) assert.ok(S.connect(graph, f, t, 'merge').ok);
const live = { chat: [{ is_user: true, mes: 'hi' }], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const texts = () => C.collect(graph, 'out', live, { gen: 'GEN' }).messages.map(m => m.content).join('|');
assert.equal(texts(), 'SYS|A|GEN');

const cv = new Canvas(document.getElementById('host'), { onChange() {}, onToast: m => toasts.push(m) });
const toasts = [];
cv.setGraph(graph);
cv.render();
const M = (type, target, x, y, extra = {}) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra }));
const nodeEl = (id) => document.querySelector(`.pc-node[data-id="${id}"]`);

// An empty blanket: drawn, empty, and folding it is refused.
graph.nodes.a.x = 900; graph.nodes.a.y = 900;
const g = S.createBlanket(graph, -40, 150, { w: 400, h: 200, title: 'Needs' });
cv.render();
const frame = () => document.querySelector(`.pc-group-frame[data-group="${g.id}"]`);
assert.ok(frame(), 'an empty blanket is drawn');
assert.match(frame().textContent, /empty/);
cv.setCollapsed(g.id, true);
assert.equal(g.collapsed, false, 'nothing to fold');
assert.ok(toasts.length);

// Drop "a" on it: it joins. (jsdom: blocks have no height, so their middle is their top edge.)
settleAt('a', 20, 210);
assert.equal(graph.nodes.a.inGroup, g.id, 'dropped on the blanket, joins');
// Drag "b" (outside) onto it by mouse.
M('mousedown', nodeEl('b'), 310, 210);
M('mousemove', window, 110, 230);
assert.ok(frame().classList.contains('pc-group-drop'), 'the blanket lights up under a dragged block');
M('mouseup', window, 110, 230);
assert.equal(graph.nodes.b.inGroup, g.id, 'dragged onto the blanket, joins');
assert.ok(!frame().classList.contains('pc-group-drop'));
// Drag "b" off again: it leaves.
M('mousedown', nodeEl('b'), 110, 230);
M('mousemove', window, 610, 530);
M('mouseup', window, 610, 530);
assert.equal(graph.nodes.b.inGroup, undefined, 'dragged off, leaves');
// Output never joins, even when put on the blanket.
graph.nodes.out.x = 10; graph.nodes.out.y = 250;
cv.settle(['out']);
assert.equal(graph.nodes.out.inGroup, undefined);
graph.nodes.out.x = 0; graph.nodes.out.y = 700;

// Moving the blanket moves its blocks and picks up what it now lies under.
graph.nodes.b.x = 300; graph.nodes.b.y = 260;      // b just right of the blanket (its middle is at x=430)
cv.render();
const head = () => frame().querySelector('.pc-group-frame-head');
M('mousedown', head(), 0, 160);
M('mousemove', window, 200, 160);
M('mouseup', window, 200, 160);
assert.deepEqual([g.frame.x, graph.nodes.a.x], [160, 220], 'blanket and its block moved together');
assert.equal(graph.nodes.b.inGroup, g.id, 'the moved blanket now lies under b');

// Resizing: shrink it so b falls off.
M('mousedown', frame().querySelector('.pc-group-resize'), 560, 350);
M('mousemove', window, 400, 350);
M('mouseup', window, 400, 350);
assert.ok(g.frame.w < 400);
assert.equal(graph.nodes.b.inGroup, undefined, 'shrunk from under b');
assert.equal(graph.nodes.a.inGroup, g.id);
// Never smaller than the minimum, and never so small that a block still on it hangs off.
M('mousedown', frame().querySelector('.pc-group-resize'), 400, 350);
M('mousemove', window, -900, -900);
M('mouseup', window, -900, -900);
assert.equal(g.frame.h, S.GROUP_MIN.h);
assert.equal(g.frame.x + g.frame.w, graph.nodes.a.x + 260 + 16, 'grows back to keep a on it');
assert.equal(graph.nodes.a.inGroup, g.id);
g.frame.w = 400; g.frame.h = 200;
settleAt('b', 260, 210);
assert.equal(graph.nodes.b.inGroup, g.id);

// Fold: one block with an open button and a switch; open it again from the block.
cv.setCollapsed(g.id, true);
assert.equal(g.collapsed, true);
assert.deepEqual([g.x, g.y], [g.frame.x, g.frame.y], 'the folded block sits where the blanket was');
const gel = document.querySelector('.pc-node-group');
assert.ok(gel.querySelector('[data-action="open"]'));
assert.ok(gel.querySelector('[data-action="toggle"]'));
M('mousedown', gel.querySelector('[data-action="open"]'), 0, 0);
assert.equal(g.collapsed, false, 'opened from the block itself');

// The prompt is the same with the group on, open or folded.
assert.equal(texts(), 'SYS|A|GEN');

// Switch the group off from its blanket: nothing in it is sent, nothing passes through.
M('mousedown', frame().querySelector('[data-action="toggle"]'), 0, 0);
assert.equal(g.enabled, false);
assert.ok(nodeEl('a').classList.contains('pc-group-off'));
assert.equal(graph.nodes.a.enabled, true, 'the blocks keep their own switch');
assert.equal(texts(), 'SYS|GEN', 'a is gone');
assert.equal(C.collect(graph, 'gen', live).messages.length, 0, 'b feeds gen from inside the off group: gen is asked nothing');
assert.equal(C.generateOrder(graph).map(x => x.id).join(), 'gen', 'gen itself is not in the group');
// A Generate block inside an off group costs nothing.
graph.nodes.gen.inGroup = g.id;
assert.equal(R.callCount(graph), 0, 'no model calls for a Generate block in an off group');
assert.equal(C.generateOrder(graph).length, 0);
delete graph.nodes.gen.inGroup;
// Everything wired through an off group stops there.
assert.ok(S.connect(graph, 'lore', 'a', 'merge').ok);
assert.ok(!texts().includes('lore'));
// On again, all back.
cv.toggleGroup(g.id);
assert.equal(g.enabled, undefined);
assert.equal(texts().split('|')[0], 'SYS');
assert.ok(texts().includes('A'));

// The Lorebook block's own group filter survives grouping and ungrouping.
S.ungroup(graph, g.id);
const g2 = S.groupNodes(graph, ['lore', 'sys'], 'L');
assert.equal(graph.nodes.lore.group, 'Tavern');
assert.equal(graph.nodes.lore.inGroup, g2.id);
S.ungroup(graph, g2.id);
assert.equal(graph.nodes.lore.group, 'Tavern');

// Old canvases: membership moves from node.group to node.inGroup, and a
// Lorebook filter that is not a group id stays put.
const old = { id: 'o', migrated: 1, nodes: { x: { id: 'x', group: 'grp1' }, y: { id: 'y', type: 'lorebook', group: 'Tavern' } }, wires: {}, groups: { grp1: { id: 'grp1', collapsed: true } } };
S.migrateGraph(old);
assert.deepEqual([old.nodes.x.inGroup, old.nodes.x.group, old.nodes.y.group, old.nodes.y.inGroup], ['grp1', undefined, 'Tavern', undefined]);

console.log('blankets: ok');

function settleAt(id, x, y) {
    graph.nodes[id].x = x; graph.nodes[id].y = y;
    cv.render();
    cv.settle([id]);
}
