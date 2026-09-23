// Undo and redo: one step per action, typing coalesced, labels that say what
// the step was, redo cleared by a new change, and a cap on how far back.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const H = await import(`../src/history.js?v=${v}`);
S.onGraphTouched((g) => H.noteChange(g));
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

const g = S.createGraph('T');
H.track(g);
const out = S.outputNode(g);

// add, connect, delete: one step each, named
const a = S.addNode(g, 'prompt', 0, 0); a.title = 'Scene';
await tick();
const w = S.connect(g, a.id, out.id, 'merge');
await tick();
assert.equal(H.peek(g).undo, 'connect "Scene" → "Output"');
S.removeNode(g, a.id);
await tick();
assert.equal(H.peek(g).undo, 'delete "Scene"');
assert.equal(Object.keys(g.wires).length, 0);

assert.equal(H.undo(g), 'delete "Scene"');
assert.ok(g.nodes[a.id], 'block back');
assert.ok(g.wires[w.wire.id], 'its wire back too');
assert.equal(H.peek(g).redo, 'delete "Scene"');
assert.equal(H.redo(g), 'delete "Scene"');
assert.ok(!g.nodes[a.id]);
H.undo(g);

// typing: many edits, one step
const node = g.nodes[a.id];
for (const ch of 'Hello there') { node.content = (node.content ?? '') + ch; S.touchGraph(g); await tick(2); }
assert.equal(H.peek(g).undo, 'your last edit', 'pending while you are still typing');
await tick(800);
assert.equal(H.peek(g).undo, 'edit "Scene"');
H.undo(g);
assert.equal(g.nodes[a.id].content ?? '', '', 'all the typing undone in one step');
// an undo right after typing, before the pause, still catches it
g.nodes[a.id].content = 'quick'; S.touchGraph(g);
assert.equal(H.undo(g), 'edit "Scene"');
assert.equal(g.nodes[a.id].content ?? '', '');

// move and switch off are named as such
g.nodes[a.id].x = 300; S.touchGraph(g); await tick();
assert.equal(H.peek(g).undo, 'move "Scene"');
g.nodes[a.id].enabled = false; S.touchGraph(g); await tick();
assert.equal(H.peek(g).undo, 'switch off "Scene"');

// one click that makes many changes is one step
for (let i = 0; i < 5; i++) S.addNode(g, 'prompt', 0, i * 100);
await tick();
assert.equal(H.peek(g).undo, 'add 5 blocks');
H.undo(g);
assert.equal(Object.keys(g.nodes).length, 2);

// a new change clears redo
H.undo(g);
assert.ok(H.peek(g).redo);
S.addNode(g, 'note', 0, 0); await tick();
assert.equal(H.peek(g).redo, null);

// pan/zoom is not a step
const before = H.peek(g).undo;
g.view = { x: 10, y: 10, zoom: 2 }; S.touchGraph(g); await tick(800);
assert.equal(H.peek(g).undo, before);

// capped at 50 steps
for (let i = 0; i < 70; i++) { S.addNode(g, 'note', i, 0); await tick(1); }
let n = 0; while (H.undo(g)) n++;
assert.equal(n, 50);

// each canvas has its own history
const g2 = S.createGraph('Other'); H.track(g2);
assert.equal(H.peek(g2).undo, null);
console.log('history: ok');
