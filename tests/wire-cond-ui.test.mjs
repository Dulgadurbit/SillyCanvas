// Conditions on wires in the panel, and the State block's editor.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const chat = Array.from({ length: 4 }, (_, i) => [{ is_user: true, mes: `u${i}` }, { is_user: false, mes: `c${i}` }]).flat();
const c = installMock({ settings: { graphs: {} }, chat });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
let saved = 0; c.saveChat = async () => { saved++; };
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const g = S.resolveGraph().graph;
const st = S.addNode(g, S.NODE_TYPES.STATE, 100, 100);
UI.open();
await tick(60);
const select = (id) => {
    document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
};
assert.match(document.querySelector(`.pc-node[data-id="${st.id}"]`).textContent, /No values yet/);
select(st.id);
await tick();
// The State block edits in its own window.
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Open the State editor')).click();
await tick();
const win = () => document.querySelector('.pc-sw');
assert.ok(win(), 'the State window opens');
[...win().querySelectorAll('.pc-btn')].find(b => b.textContent.includes('Add a value')).click();
await tick();
assert.equal(st.values.length, 1);
assert.equal(st.values[0].name, 'energy');
// split into 5 stages
[...win().querySelectorAll('.pc-sw-splitbtn')].find(b => b.textContent === '5').click();
await tick();
assert.equal(st.values[0].stages.length, 5);
assert.deepEqual([st.values[0].stages[0].from, st.values[0].stages[0].to, st.values[0].stages[4].from, st.values[0].stages[4].to], [9, 10, 0, 1]);
// its own output dot, and "now" = 10 - 4 turns
assert.ok(document.querySelector(`.pc-node[data-id="${st.id}"] .pc-port-key`), 'an output dot per value');
assert.match(win().querySelector('.pc-sw-value-now').textContent, /^6/);
assert.match(win().querySelector('.pc-sw-legend').textContent, /8 messages · 4 turns · changed 4×/);
// the chart: a step line, one dot per change
assert.ok(win().querySelector('.pc-sw-line'));
assert.equal(win().querySelectorAll('.pc-sw-event').length, 4);
// scrub back to message 2 (turn 1): 9, and its stage is the top one
const slider = win().querySelector('.pc-sw-slider');
slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
assert.equal(win().querySelector('.pc-sw-bigval').textContent, '9');
// try a message
const tryIn = win().querySelector('.pc-sw-tryrow input');
tryIn.value = 'hello'; tryIn.dispatchEvent(new dom.window.Event('input'));
assert.match(win().querySelector('.pc-sw-tryout').textContent, /energy 6 → 5/);
// set by hand, on the Range & output tab
[...win().querySelectorAll('.pc-sw-tab')].find(t => t.textContent.startsWith('Range')).click();
await tick();
const setRow = [...win().querySelectorAll('.pc-field')].find(f => f.textContent.startsWith('Set it by hand'));
setRow.querySelector('input').value = '3';
[...setRow.querySelectorAll('.pc-btn')].find(b => b.textContent === 'Set now').click();
await tick(80);
assert.equal(chat.at(-1).extra.promptCanvasState[st.id][st.values[0].id], 3);
assert.ok(saved > 0);
assert.match(win().querySelector('.pc-sw-value-now').textContent, /^3/);
// Escape closes the window, not the panel
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(win(), null);
assert.ok(UI.isOpen());
assert.match(document.querySelector('.pc-inspector').textContent, /energy3/);

// a wire with a condition
const p = S.addNode(g, S.NODE_TYPES.PROMPT, 100, 500); p.content = 'hi';
const res = S.connect(g, p.id, S.outputNode(g).id, 'merge');
UI.close(); UI.open(); await tick(60);
const hit = document.querySelector(`.pc-wire-hit[data-id="${res.wire.id}"]`);
hit.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
await tick();
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Add a condition')).click();
await tick();
assert.equal(res.wire.condition.mode, 'expr');
const f = [...document.querySelectorAll('.pc-wire-cond input')].find(i => i.placeholder.includes('energy'));
f.value = 'energy <= 2'; f.dispatchEvent(new dom.window.Event('input'));
assert.equal(res.wire.condition.formula, 'energy <= 2');
assert.match(document.querySelector('.pc-wire-cond').textContent, /looks right/);
f.value = 'energi <= 2'; f.dispatchEvent(new dom.window.Event('input'));
assert.match(document.querySelector('.pc-wire-cond').textContent, /unknown name: energi/);
await tick();
assert.ok([...document.querySelectorAll('.pc-wire-label')].some(l => l.textContent.includes('if energi <= 2')));
console.log('wire-cond-ui: ok');
