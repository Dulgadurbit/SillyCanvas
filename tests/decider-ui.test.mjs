// The Decider on the canvas and in the inspector: one port per key, wiring
// from a key, choice shown on the block, and the inspector's key editor.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="host"></div><div id="chat"></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent });
const { installMock } = await import('./mock.js');
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { Canvas, ruleLabel } = await import(`../src/canvas.js?v=${v}`);
const { defaultNode, connect, NODE_TYPES, newDeciderKey } = await import(`../src/state.js?v=${v}`);

// a new Decider starts empty and says so
{
    const fresh = { ...defaultNode(NODE_TYPES.DECIDER, 0, 0), id: 'fresh' };
    assert.equal(fresh.mode, null);
    assert.deepEqual(fresh.keys, []);
    const cv0 = new Canvas(document.getElementById('host'), { onChange() {}, onToast() {} });
    cv0.setGraph({ nodes: { fresh }, wires: {}, view: { x: 0, y: 0, zoom: 1 } });
    cv0.render();
    assert.match(document.querySelector('.pc-node[data-id="fresh"]').textContent, /Not set up yet/);
    assert.ok(document.querySelector('.pc-node[data-id="fresh"] .pc-help-btn'), '? button');
    document.getElementById('host').innerHTML = '';
}

const dec = { ...defaultNode(NODE_TYPES.DECIDER, 0, 0), id: 'dec' };
dec.mode = 'first';
dec.keys.push(newDeciderKey('DESLOP'));
dec.keys[0].name = 'DESLOP';
dec.keys[0].conditions[0].terms = 'Elara\nLyra';
const n = (id, type, x, y) => ({ ...defaultNode(type, x, y), id, title: id });
const graph = { nodes: { dec, a: n('a', 'prompt', 0, 400), b: n('b', 'prompt', 300, 400), out: n('out', 'output', 0, 800) }, wires: {}, view: { x: 0, y: 0, zoom: 1 } };
const toasts = [];
const cv = new Canvas(document.getElementById('host'), { onChange() {}, onToast: m => toasts.push(m) });
cv.setGraph(graph);
cv.render();

const ports = [...document.querySelectorAll('.pc-node[data-id="dec"] .pc-port-key')];
assert.equal(ports.length, 2, 'one port per key plus fallback');
assert.deepEqual(ports.map(p => p.textContent), ['DESLOP', 'Otherwise']);
assert.match(document.querySelector('.pc-node[data-id="dec"] .pc-dec-keys').textContent, /DESLOP.*"Elara", "Lyra" in input/);
assert.equal(document.querySelector('.pc-node[data-id="dec"] .pc-port-strip'), null);

const M = (type, target, x, y) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
// drag from the DESLOP port to block a, from Otherwise to b
M('mousedown', ports[0], 87, 90);
M('mouseup', document.querySelector('.pc-node[data-id="a"]'), 60, 420);
M('mousedown', document.querySelectorAll('.pc-node[data-id="dec"] .pc-port-key')[1], 173, 90);
M('mouseup', document.querySelector('.pc-node[data-id="b"]'), 360, 420);
assert.deepEqual(toasts, []);
const wires = Object.values(graph.wires);
assert.equal(wires.find(w => w.to === 'a').port, dec.keys[0].id);
assert.equal(wires.find(w => w.to === 'b').port, dec.fallback.id);
assert.deepEqual([...document.querySelectorAll('.pc-wire-label')].map(l => l.textContent).sort(), ['DESLOP', 'Otherwise']);

// after a run: chosen key highlighted, other wire dimmed
cv.setTrace([{ id: 'dec', status: 'in', decision: [dec.fallback.id] }]);
assert.ok(document.querySelector('.pc-port-key.pc-port-fallback').classList.contains('pc-port-chosen'));
assert.equal(document.querySelectorAll('.pc-wire-untaken').length, 1);

// labels for the new rule kinds
assert.equal(ruleLabel({ mode: 'time', from: '22:00', to: '06:00' }), '22:00–06:00');
assert.equal(ruleLabel({ mode: 'length', op: 'gt', value: 300 }), 'input > 300 words');
assert.equal(ruleLabel({ mode: 'chat', what: 'lastSpeaker', value: 'user' }), 'last speaker: user');
assert.equal(ruleLabel({ mode: 'search', scope: 'incoming', terms: 'x', not: true }), 'NOT "x" in input');
console.log('decider-ui: ok');
