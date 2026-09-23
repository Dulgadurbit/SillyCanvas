// Undo in the real panel: buttons, Ctrl+Z / Ctrl+Shift+Z, the delete toast,
// and Ctrl+Z inside a text box left to the browser.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
const toasts = [];
globalThis.toastr = { info: (m, t, o) => toasts.push({ m, o }), warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const key = (k, opts = {}, target = document) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

const g = S.resolveGraph().graph;
const n = S.addNode(g, S.NODE_TYPES.PROMPT, 100, 100); n.title = 'Scene';
UI.open();
await tick(30);
const undoBtn = document.querySelector('.pc-undo');
const redoBtn = document.querySelector('.pc-redo');
assert.ok(undoBtn.classList.contains('pc-disabled'), 'nothing to undo yet: history starts when the canvas opens');

// select the block, delete it with the Delete key
const el = document.querySelector(`.pc-node[data-id="${n.id}"]`);
el.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
key('Delete');
await tick();
assert.ok(!g.nodes[n.id], 'deleted');
const t = toasts.find(x => /Deleted "Scene"/.test(x.m));
assert.ok(t, 'toast offers undo');
assert.ok(!undoBtn.classList.contains('pc-disabled'));
assert.match(undoBtn.title, /Undo: delete "Scene"/);

// the toast's click undoes
t.o.onclick();
await tick();
assert.ok(g.nodes[n.id], 'restored from the toast');
assert.ok(document.querySelector(`.pc-node[data-id="${n.id}"]`), 'and drawn');
assert.match(redoBtn.title, /Redo: delete "Scene"/);

// Ctrl+Shift+Z redoes, Ctrl+Z undoes
key('z', { ctrlKey: true, shiftKey: true });
await tick();
assert.ok(!g.nodes[n.id]);
key('z', { ctrlKey: true });
await tick();
assert.ok(g.nodes[n.id]);
key('y', { ctrlKey: true });
await tick();
assert.ok(!g.nodes[n.id], 'Ctrl+Y redoes too');
undoBtn.click();
await tick();
assert.ok(g.nodes[n.id], 'button undoes');

// in a text box, Ctrl+Z belongs to the browser
const ta = document.createElement('textarea');
document.querySelector('.pc-root').append(ta);
ta.focus();
S.removeNode(g, n.id); await tick();
key('z', { ctrlKey: true }, ta);
await tick();
assert.ok(!g.nodes[n.id], 'canvas undo not triggered while typing');
console.log('undo-ui: ok');
