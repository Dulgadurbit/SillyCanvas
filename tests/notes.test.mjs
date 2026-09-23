// Block names in the chat, the OFF look, and saving by dragging a block onto
// the library (anywhere on it, not only onto a folder).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
const toasts = [];
globalThis.toastr = { info: m => toasts.push(m), warning: m => toasts.push(m), success: m => toasts.push(m), error: m => toasts.push(m) };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const L = await import(`../src/library.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const { livePanel } = await import(`../src/thoughts.js?v=${v}`);

// chat shows the block's own name, custom heading beside it
livePanel.result({ id: 'a', title: 'Scene plan', label: 'Notes', text: 'x', show: true });
livePanel.result({ id: 'b', title: 'Characters', label: 'Cast', text: 'y', show: true });
const labels = [...document.querySelectorAll('.pc-live .pc-thought-label')].map(l => l.textContent);
assert.deepEqual(labels, ['Scene plan', 'Characters Cast']);
livePanel.clear();
assert.equal(S.defaultNode('generate', 0, 0).label, '');

// OFF is obvious
const g = S.resolveGraph().graph;
const p = S.addNode(g, S.NODE_TYPES.PROMPT, 200, 200);
p.title = 'Draft rules'; p.content = 'Be brief.'; p.enabled = false;
UI.open();
await new Promise(r => setTimeout(r, 30));
const el = document.querySelector(`.pc-node[data-id="${p.id}"]`);
assert.ok(el.classList.contains('pc-off'));
assert.equal(el.querySelector('.pc-off-pill')?.textContent, 'OFF');
assert.ok(el.querySelector('.pc-toggle-off'));

// drag the block onto the library (not onto a folder) -> saved in the first folder
const side = document.querySelector('.pc-sidebar');
const before = L.prompts().length;
document.elementFromPoint = () => side;               // jsdom has no layout
el.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 210, clientY: 210 }));
window.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 300 }));
assert.ok(side.classList.contains('pc-drop-zone'), 'library shows it can take the block');
assert.ok(side.classList.contains('pc-drop-ready'));
assert.match(side.dataset.dropHint, /My prompts|Drop to save/);
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 300 }));
assert.equal(L.prompts().length, before + 1, 'saved');
assert.equal(L.prompts().at(-1).name, 'Draft rules');
assert.ok(!side.classList.contains('pc-drop-zone'), 'hint cleared');
assert.equal(p.x, 200, 'block goes back where it was');

// dropping on the SillyTavern folder no longer refuses
const stFolder = [...document.querySelectorAll('.pc-folder')].find(f => f.dataset.folder === '');
document.elementFromPoint = () => stFolder.querySelector('.pc-folder-head');
const el2 = document.querySelector(`.pc-node[data-id="${p.id}"]`);
el2.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 210, clientY: 210 }));
window.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 100 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 100 }));
assert.ok(!toasts.some(t => /live in your preset/.test(t)));
assert.ok(toasts.some(t => /Updated "Draft rules"/.test(t)), 'same block updates its saved copy');
console.log('notes: ok');
