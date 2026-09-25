// Groups: pick several blocks (Shift-click, Shift-drag box), fold them into
// one block with what crosses its edge, open and fold again, drag as one,
// ungroup, and undo. The prompt is built the same either way.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="host"></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent });
const { installMock } = await import('./mock.js');
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { Canvas } = await import(`../src/canvas.js?v=${v}`);
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const H = await import(`../src/history.js?v=${v}`);

const n = (id, type, x, y, extra = {}) => ({ ...S.defaultNode(type, x, y), id, title: id, ...extra });
const graph = { id: 'g', nodes: {
    sys: n('sys', 'prompt', 0, 0, { content: 'SYS' }),
    a: n('a', 'prompt', 0, 200, { content: 'A' }),
    b: n('b', 'prompt', 300, 200, { content: 'B' }),
    c: n('c', 'prompt', 0, 400, { content: 'C' }),
    out: n('out', 'output', 0, 700),
}, wires: {}, view: { x: 0, y: 0, zoom: 1 } };
for (const [f, t] of [['sys', 'a'], ['a', 'c'], ['b', 'c'], ['c', 'out']]) assert.ok(S.connect(graph, f, t, 'merge').ok);
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const before = C.collect(graph, 'out', live).messages;
H.track(graph);

const multis = [];
const cv = new Canvas(document.getElementById('host'), { onChange() {}, onToast: m => { throw new Error(m); }, onMulti: (ids) => multis.push(ids) });
cv.setGraph(graph);
cv.render();
const M = (type, target, x, y, extra = {}) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra }));
const nodeEl = (id) => document.querySelector(`.pc-node[data-id="${id}"]`);

// Shift-click picks several
M('mousedown', nodeEl('a'), 10, 210);
M('mouseup', window, 10, 210);
M('mousedown', nodeEl('b'), 310, 210, { shiftKey: true });
assert.deepEqual([...cv.multi].sort(), ['a', 'b']);
assert.ok(nodeEl('a').classList.contains('pc-multi'));
// Shift-drag box on empty canvas picks what it touches
M('mousedown', document.getElementById('host'), 900, 150, { shiftKey: true });
M('mousemove', window, -20, 450);
M('mouseup', window, -20, 450);
assert.deepEqual([...cv.multi].sort(), ['a', 'b', 'c']);
assert.deepEqual(multis.at(-1).sort(), ['a', 'b', 'c']);

// group them
const g = S.groupNodes(graph, [...cv.multi, 'out'], 'Needs');
assert.ok(g, 'grouped');
assert.equal(graph.nodes.out.inGroup, undefined, 'Output never goes in a group');
cv.setMulti([]);
cv.render();
assert.equal(nodeEl('a'), null, 'members are folded away');
const gel = document.querySelector('.pc-node-group');
assert.ok(gel);
assert.match(gel.textContent, /Needs/);
assert.match(gel.textContent, /3 blocks/);
assert.match(gel.textContent, /in: sys/);
assert.match(gel.textContent, /out: out/);
// only wires that cross the edge are drawn
assert.equal(document.querySelectorAll('.pc-wire-hit').length, 2, 'sys->a and c->out; a->c and b->c are inside');
// the prompt is the same
assert.deepEqual(C.collect(graph, 'out', live).messages, before);

// drag the folded group: its blocks move with it
M('mousedown', gel, 10, 10);
M('mousemove', window, 60, 110);
M('mouseup', window, 60, 110);
assert.deepEqual([graph.nodes.a.x, graph.nodes.a.y, graph.nodes.b.x, graph.nodes.c.y], [50, 300, 350, 500]);
assert.deepEqual([g.x, g.y], [50, 300]);

// open it: blocks back, with a frame
cv.setCollapsed(g.id, false);
assert.ok(nodeEl('a'));
assert.ok(document.querySelector('.pc-group-frame'));
assert.equal(document.querySelectorAll('.pc-wire-hit').length, 4);
// double-click the frame head folds it again
document.querySelector('.pc-group-frame-head').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
assert.equal(g.collapsed, true);

// undo takes the group back apart, redo brings it back
await new Promise(r => setTimeout(r, 10));
H.noteChange(graph);
await new Promise(r => setTimeout(r, 10));        // the grouping becomes one undo step
const before2 = JSON.stringify(graph.groups);
S.ungroup(graph, g.id);
H.noteChange(graph);
assert.deepEqual(graph.groups, {});
assert.equal(graph.nodes.a.inGroup, undefined);
H.undo(graph);
assert.equal(JSON.stringify(graph.groups), before2, 'undo restores the group');
assert.equal(graph.nodes.a.inGroup, g.id);

// Delete on a selected group deletes it with its blocks (Ungroup keeps them).
// With "ask before deleting" on, a No keeps everything.
let answer = false;
const asked = [];
const cv2 = new Canvas(document.getElementById('host'), { onChange() {}, confirmDelete: async (what) => { asked.push(what); return answer; } });
cv2.setGraph(graph);
cv2.render();
cv2.select({ kind: 'group', id: g.id });
assert.equal(await cv2.deleteSelection(), false);
assert.match(asked[0], /the group "Needs" and its 3 blocks/);
assert.ok(graph.nodes.a && graph.groups[g.id], 'said no: nothing gone');
answer = true;
assert.equal(await cv2.deleteSelection(), true);
assert.ok(!graph.nodes.a && !graph.nodes.b && !graph.nodes.c, 'the blocks went with it');
assert.ok(graph.nodes.sys && graph.nodes.out, 'the rest stays');
assert.deepEqual(graph.groups, {});
console.log('groups: ok');
