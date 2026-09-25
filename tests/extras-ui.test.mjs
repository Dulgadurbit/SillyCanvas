// Small things from the 0.15 list: the "sent together" badge under a reply,
// library colours by block type, ask-before-deleting, and one click from a
// Generate block to keeping its answers in a memory (and a lorebook).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"><div class="mes" mesid="0"><div class="mes_block"><div class="mes_text">hi</div></div></div></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
const toasts = [];
globalThis.toastr = { info: m => toasts.push(m), warning: m => toasts.push(m), success: m => toasts.push(m), error: m => toasts.push(m) };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {}, ui: {} }, chat: [{ is_user: true, mes: 'hi', extra: {} }] });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
c.saveChat = async () => {};
let confirmAnswer = true, confirms = 0;
c.POPUP_TYPE = { CONFIRM: 1, INPUT: 2 }; c.POPUP_RESULT = { AFFIRMATIVE: 1 };
c.callGenericPopup = async () => { confirms++; return confirmAnswer ? 1 : 0; };
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const L = await import(`../src/library.js?v=${v}`);
const K = await import(`../src/clip.js?v=${v}`);
const T = await import(`../src/thoughts.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

// 1. "Sent together": the badge names the others, and survives being saved on the message.
T.attachThoughts(0, [
    { title: 'Scene', text: 'S', together: ['Characters', 'Weather'] },
    { title: 'Alone', text: 'A' },
]);
const badges = [...document.querySelectorAll('.mes .pc-thought-together')];
assert.equal(badges.length, 1);
assert.match(badges[0].textContent, /with 2 others/);
assert.match(badges[0].title, /Characters, Weather/);
assert.deepEqual(c.chat[0].extra.promptCanvas.thoughts[0].together, ['Characters', 'Weather']);
assert.equal(c.chat[0].extra.promptCanvas.thoughts[1].together, null);

// 2. Library colours: every entry carries its block type.
const g = S.resolveGraph().graph;
const gen = S.addNode(g, 'generate', 100, 100); gen.title = 'Lore maker';
const dec = S.addNode(g, 'decider', 400, 100);
L.createPrompt({ name: 'Plain' });
L.createPiece({ name: 'A generator', clip: K.makeClip(g, { nodeIds: [gen.id] }) });
L.createPiece({ name: 'Two', clip: K.makeClip(g, { nodeIds: [gen.id, dec.id] }) });
UI.open();
await tick(60);
const item = (name) => [...document.querySelectorAll('.pc-lib-item')].find(i => i.textContent.includes(name));
assert.ok(item('Plain').classList.contains('pc-lib-t-prompt'));
assert.ok(item('A generator').classList.contains('pc-lib-t-generate'));
assert.ok(item('Two').classList.contains('pc-lib-t-several'));
assert.ok(item('Main') === undefined || item('Main').classList.contains('pc-lib-t-st'));
assert.ok(document.querySelector('.pc-block-chip.pc-lib-t-decider'), 'the block chips too');

// 3. Ask before deleting: off by default (no question), on in settings.
const select = (id) => {
    document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
};
const key = (k) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
select(dec.id); await tick();
key('Delete'); await tick();
assert.equal(g.nodes[dec.id], undefined, 'deleted without asking');
assert.equal(confirms, 0);
c.extensionSettings['prompt-canvas'].ui.confirmDelete = true;
const p2 = S.addNode(g, 'prompt', 400, 400); UI.close(); UI.open(); await tick(60);
select(p2.id); await tick();
confirmAnswer = false;
key('Delete'); await tick();
assert.equal(confirms, 1);
assert.ok(g.nodes[p2.id], 'said no: still there');
confirmAnswer = true;
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Delete this block')).click();
await tick();
assert.equal(confirms, 2);
assert.equal(g.nodes[p2.id], undefined);

// 4. One click from a Generate block to keeping its answers.
select(gen.id); await tick();
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Save its answers')).click();
await tick();
const mem = Object.values(g.nodes).find(n => n.type === 'memory');
assert.ok(mem, 'a memory was made');
assert.equal(mem.saveMode, 'append');
assert.equal(mem.lore.on, true);
assert.ok(Object.values(g.wires).some(w => w.kind === 'save' && w.from === gen.id && w.to === mem.id));
assert.match(document.querySelector('.pc-inspector').textContent, /Also keep it in a lorebook entry/);
// again: reuses it
select(gen.id); await tick();
[...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => b.textContent.includes('Save its answers')).click();
await tick();
assert.equal(Object.values(g.nodes).filter(n => n.type === 'memory').length, 1);
console.log('extras-ui: ok');
