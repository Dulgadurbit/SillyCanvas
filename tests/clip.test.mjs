// Copy and paste: blocks, the wires between them and their groups, into the
// same canvas or another one, with fresh ids every time.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const K = await import(`../src/clip.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);

const n = (id, type, x, y, extra = {}) => ({ ...S.defaultNode(type, x, y), id, title: id, ...extra });
const a = { id: 'A', nodes: {
    p: n('p', 'prompt', 0, 0, { content: 'P' }),
    q: n('q', 'prompt', 300, 0, { content: 'Q' }),
    d: n('d', 'decider', 0, 200),
    r: n('r', 'prompt', 0, 400, { content: 'R' }),
    out: n('out', 'output', 0, 700),
}, wires: {}, groups: {} };
const wp = S.connect(a, 'p', 'd', 'merge').wire;
S.connect(a, 'q', 'd', 'merge');
S.connect(a, 'd', 'r', 'merge', { port: null });
S.connect(a, 'r', 'out', 'merge');
a.nodes.d.keys = [{ id: 'k1', name: 'yes', conditions: [{ mode: 'search', terms: 'x', input: wp.id }] }];

// Output is never copied; wires only when both ends are copied.
const clip = K.makeClip(a, { nodeIds: ['p', 'd', 'out'] });
assert.deepEqual(clip.nodes.map(x => x.id).sort(), ['d', 'p']);
assert.equal(clip.wires.length, 1, 'p -> d only');
assert.deepEqual(clip.origin, { x: 0, y: 0 });

// Through text and back, as the clipboard carries it.
const back = K.readClip(JSON.stringify(clip));
assert.ok(back);
assert.equal(K.readClip('hello'), null);
assert.equal(K.readClip('{"sillyCanvasClip":1,"nodes":[{"id":"x","type":"output"}]}'), null, 'no Outputs from outside');

// Paste into another canvas at a spot.
const b = S.blankGraph('B');
const res = K.pasteClip(b, back, { x: 1000, y: 500 });
assert.equal(res.nodeIds.length, 2);
const [np, nd] = ['p', 'd'].map(t => Object.values(b.nodes).find(x => x.title === t));
assert.ok(np && nd);
assert.notEqual(np.id, 'p', 'fresh ids');
assert.deepEqual([np.x, np.y, nd.x, nd.y], [1000, 500, 1000, 700]);
const w = Object.values(b.wires);
assert.equal(w.length, 1);
assert.deepEqual([w[0].from, w[0].to], [np.id, nd.id]);
assert.equal(nd.keys[0].conditions[0].input, w[0].id, 'a Decider rule reading one input follows its wire');
// Paste again: another set, nothing shared.
const res2 = K.pasteClip(b, back);
assert.equal(new Set([...res.nodeIds, ...res2.nodeIds]).size, 4);
assert.equal(Object.keys(b.wires).length, 2);
// A rule reading an input that did not come along forgets it.
const lone = K.pasteClip(b, K.makeClip(a, { nodeIds: ['d'] }));
assert.equal(b.nodes[lone.nodeIds[0]].keys[0].conditions[0].input, undefined);
// The original is untouched.
assert.equal(a.nodes.d.keys[0].conditions[0].input, wp.id);

// Groups come along with their blocks, folded or open.
const g = S.groupNodes(a, ['p', 'q'], 'Pair');
const gclip = K.makeClip(a, { groupIds: [g.id] });
assert.equal(gclip.nodes.length, 2);
assert.equal(K.describeClip(gclip), 'group "Pair" (2 blocks)');
const gres = K.pasteClip(b, gclip, { x: 0, y: 0 });
assert.equal(gres.groupIds.length, 1);
assert.deepEqual(gres.loose, []);
const ng = b.groups[gres.groupIds[0]];
assert.equal(ng.title, 'Pair');
assert.equal(ng.collapsed, true);
assert.deepEqual(S.groupMembers(b, ng.id).map(x => x.title).sort(), ['p', 'q']);
// A block copied without its group comes out loose.
const one = K.pasteClip(b, K.makeClip(a, { nodeIds: ['p'] }));
assert.equal(b.nodes[one.nodeIds[0]].inGroup, undefined);
assert.deepEqual(one.loose, one.nodeIds);
// An open blanket's frame moves with the paste.
g.collapsed = false; g.frame = { x: -24, y: -48, w: 600, h: 200 };
const oc = K.makeClip(a, { groupIds: [g.id] });
assert.deepEqual(oc.origin, { x: -24, y: -48 });
const ores = K.pasteClip(b, oc, { x: 100, y: 100 });
assert.deepEqual(b.groups[ores.groupIds[0]].frame, { x: 100, y: 100, w: 600, h: 200 });

// Pasted blocks work: wire the pasted prompt into B's Output and build.
const outB = S.outputNode(b);
S.connect(b, one.nodeIds[0], outB.id, 'merge');
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
assert.equal(C.collect(b, outB.id, live).messages.map(m => m.content).join(), 'P');
console.log('clip: ok');
