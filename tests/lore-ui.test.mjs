// The Lorebook block in the panel: lists linked lorebooks, switches modes,
// picks entries, and previews which entries fire.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} }, chat: [{ is_user: true, mes: 'the tavern', name: 'User' }] });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
c.chatMetadata = { world_info: 'World' };
c.loadWorldInfo = async () => ({ entries: { 0: { uid: 0, comment: 'Tavern', key: ['tavern'], content: 'A tavern.' }, 1: { uid: 1, comment: 'Castle', key: ['castle'], content: 'A castle.' } } });
c.getWorldInfoNames = () => ['World', 'Other'];
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const g = S.resolveGraph().graph;
const lb = S.addNode(g, S.NODE_TYPES.LOREBOOK, 100, 100);
S.connect(g, lb.id, S.outputNode(g).id, 'merge');
UI.open();
await tick(60);
const nodeEl = document.querySelector(`.pc-node[data-id="${lb.id}"]`);
assert.ok(nodeEl.textContent.includes('Lorebook'));
assert.match(nodeEl.textContent, /chat \+ character · as SillyTavern would/);
nodeEl.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
await tick(60);
const text = () => document.querySelector('.pc-inspector').textContent;
assert.match(text(), /The chat’s: World/);
// switch to "picked" and tick Castle
const modeSel = [...document.querySelectorAll('.pc-inspector select')].find(s => [...s.options].some(o => o.value === 'picked'));
modeSel.value = 'picked'; modeSel.dispatchEvent(new dom.window.Event('change'));
await tick();
const castle = [...document.querySelectorAll('.pc-lore-pick .pc-checkline')].find(l => l.textContent.includes('Castle'));
castle.querySelector('input').checked = true; castle.querySelector('input').dispatchEvent(new dom.window.Event('change'));
assert.deepEqual(lb.picked, ['World|1']);
// preview
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Which entries fire')).click();
await tick(80);
assert.match(document.querySelector('.pc-inspector .pc-select-preview').textContent, /1 entry.*Castle/s);
// add another lorebook
const add = [...document.querySelectorAll('.pc-inspector select')].find(s => [...s.options].some(o => o.value === 'Other'));
add.value = 'Other'; add.dispatchEvent(new dom.window.Event('change'));
assert.deepEqual(lb.books, ['Other']);
console.log('lore-ui: ok');
