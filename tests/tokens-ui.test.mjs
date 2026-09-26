// Every block shows its tokens, counted in the background as you edit.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} }, chat: [{ is_user: true, mes: 'hello there', name: 'User' }] });
// a tokenizer that is clearly not the four-characters estimate
c.getTokenCountAsync = async (t) => String(t).split(/\s+/).filter(Boolean).length;
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

const g = S.resolveGraph().graph;
const a = Object.assign(S.addNode(g, 'prompt', 100, 0), { title: 'Rules', content: 'one two three four five' });
const q = Object.assign(S.addNode(g, 'prompt', 400, 0), { title: 'Ask', content: 'plan the scene now' });
const gen = Object.assign(S.addNode(g, 'generate', 400, 200), { title: 'Planner', maxTokens: 300 });
S.connect(g, a.id, S.outputNode(g).id, 'merge');
S.connect(g, q.id, gen.id, 'merge');
S.connect(g, gen.id, S.outputNode(g).id, 'merge');
g.view = { x: 0, y: 0, zoom: 1 };
UI.open();
await tick(400);

const chip = (id) => document.querySelector(`.pc-node[data-id="${id}"] .pc-tok`)?.textContent;
assert.equal(chip(a.id), '5 tok', 'real tokenizer, not an estimate');
assert.equal(chip(q.id), '4 tok', 'a block that only feeds a Generate block is counted too');
assert.match(chip(gen.id), /^4 → ≤300$/, 'Generate: asked, and the most it may answer');
assert.match(chip(S.outputNode(g).id), /tok$/, 'Output shows the whole prompt');
assert.ok(document.querySelector(`.pc-node[data-id="${S.outputNode(g).id}"] .pc-tok-total`));

// edit a block: counted again without a preview
const sel = (id) => { document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })); };
sel(a.id);
const ta = document.querySelector('.pc-inspector textarea');
ta.value = 'one two'; ta.dispatchEvent(new dom.window.Event('input'));
await tick(900);
assert.equal(chip(a.id), '2 tok');

// switched off in the settings: no live counts
c.extensionSettings['prompt-canvas'].ui = { liveTokens: false };
UI.scheduleTokenCount(0);
await tick(50);
assert.equal(chip(a.id), undefined);
console.log('tokens-ui: ok');
{
    // a block wired nowhere still shows its size, marked as not sent
    c.extensionSettings['prompt-canvas'].ui = {};
    const lone = Object.assign(S.addNode(g, 'prompt', 700, 0), { title: 'Loose', content: 'a b c' });
    UI.scheduleTokenCount(0);
    await tick(80);
    const el = document.querySelector(`.pc-node[data-id="${lone.id}"] .pc-tok`);
    assert.equal(el?.textContent, '3 tok');
    assert.ok(el.classList.contains('pc-tok-loose'));
    console.log('tokens-ui (loose blocks): ok');
}
