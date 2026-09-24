// Select a wire, set its "Send what?" filter in the inspector, and see it
// saved on the wire and shown on the wire's label.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} }, chat: [
    { is_user: true, mes: 'hello', name: 'User' },
    { is_user: false, mes: 'hi there', name: 'Char' },
] });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const g = S.resolveGraph().graph;
const h = S.addNode(g, S.NODE_TYPES.HISTORY, 100, 100);
const res = S.connect(g, h.id, S.outputNode(g).id, S.WIRE_KINDS.MERGE);
assert.ok(res.ok);
const wire = res.wire;
UI.open();
await tick(30);

const hit = document.querySelector(`.pc-wire-hit[data-id="${wire.id}"]`);
assert.ok(hit, 'wire drawn');
hit.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
await tick();
assert.ok(document.body.textContent.includes('Send what?'), 'filter section shown');
assert.ok(document.querySelector('.pc-select-summary').textContent === 'everything');

const selects = () => [...document.querySelectorAll('.pc-select-box select')];
const howMany = selects().find(s => [...s.options].some(o => o.value === 'last'));
howMany.value = 'last'; howMany.dispatchEvent(new dom.window.Event('change'));
await tick();
assert.equal(wire.select?.count, 'last');
const who = selects().find(s => [...s.options].some(o => o.value === 'char'));
who.value = 'char'; who.dispatchEvent(new dom.window.Event('change'));
assert.equal(wire.select.who, 'char');
assert.match(document.querySelector('.pc-select-summary').textContent, /last 5 · char/);
const label = [...document.querySelectorAll('.pc-wire-label')].find(l => l.textContent.includes('last 5'));
assert.ok(label, 'wire label shows the filter');

// preview button
[...document.querySelectorAll('.pc-select-box .pc-btn')].find(b => b.textContent.includes('Show what')).click();
await tick(60);
assert.ok(document.querySelector('.pc-select-preview').textContent.includes('hi there'), 'preview shows the character reply');
assert.ok(!document.querySelector('.pc-select-preview').textContent.includes('hello'), 'and not the user message');

// clear
[...document.querySelectorAll('.pc-select-box .pc-btn')].find(b => b.textContent.includes('Send everything')).click();
await tick();
assert.equal(wire.select, undefined, 'filter removed');
// wire modes: Activate hides the text controls; no "Forward result" off a non-Decider
const travels = () => [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'activate'));
assert.ok(travels(), 'What travels shown');
assert.ok(![...travels().options].some(o => o.value === 'result'), 'result is only offered from a Decider');
travels().value = 'activate'; travels().dispatchEvent(new dom.window.Event('change'));
await tick();
assert.equal(wire.mode, 'activate');
assert.ok(!document.querySelector('.pc-select-box'), 'no Send what? on an Activate wire');
assert.ok([...document.querySelectorAll('.pc-wire-label')].some(l => l.textContent.includes('activate')), 'label says activate');
assert.ok(document.querySelector('.pc-wire-mode-activate'), 'drawn dashed');
travels().value = 'send'; travels().dispatchEvent(new dom.window.Event('change'));
await tick();
assert.equal(wire.mode, undefined);
console.log('select-ui: ok');
