// Easier wiring: start from the bottom-edge strip, and a near miss on empty
// canvas still lands on the closest in-port.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="host"></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent });
const { installMock } = await import('./mock.js');
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { Canvas } = await import(`../src/canvas.js?v=${v}`);

const n = (id, type, x, y) => ({ id, type, title: id, x, y, w: 260, enabled: true, role: 'system', content: 'x' });
const graph = { nodes: { a: n('a', 'prompt', 0, 0), b: n('b', 'prompt', 0, 400), out: n('out', 'output', 600, 800) }, wires: {} };
let changed = 0;
const cv = new Canvas(document.getElementById('host'), { onChange: () => changed++, onToast: (m) => { throw new Error(m); } });
graph.view = { x: 0, y: 0, zoom: 1 };
cv.setGraph(graph);
cv.render();

const strip = document.querySelector('.pc-node[data-id="a"] .pc-port-strip');
assert.ok(strip, 'bottom strip exists');
const M = (type, target, x, y) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
M('mousedown', strip, 130, 90);
assert.equal(cv.linking?.dir, 'out');
// release on empty canvas 20px off b's in-port (130, 400)
M('mousemove', document.getElementById('host'), 150, 390);
M('mouseup', document.getElementById('host'), 150, 390);
assert.ok(Object.values(graph.wires).some(w => w.from === 'a' && w.to === 'b'), 'near miss snapped to b');
// far miss does nothing
M('mousedown', document.querySelector('.pc-node[data-id="b"] .pc-port-strip'), 130, 490);
M('mouseup', document.getElementById('host'), 400, 650);
assert.equal(Object.values(graph.wires).length, 1);
console.log('wiring: ok');
