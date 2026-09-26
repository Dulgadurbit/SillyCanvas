// In the page: a Decider's "Keep its choices", the save wire's settings, and
// picking a Decider output in a Memory block's "Saved into it by".
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
const toasts = [];
globalThis.toastr = { info: m => toasts.push(m), warning: m => toasts.push(m), success: m => toasts.push(m), error: m => toasts.push(m) };
const { installMock } = await import('./mock.js');
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

const g = S.resolveGraph().graph;
const dec = Object.assign(S.addNode(g, 'decider', 100, 0), { title: 'Mood', mode: 'all' });
dec.keys = [{ id: 'k1', name: 'Combat', conditions: [{ mode: 'search', scope: 'lastUser', terms: 'sword' }] }, { id: 'k2', name: 'Calm', conditions: [] }];
g.view = { x: 0, y: 0, zoom: 1 };
UI.open();
await tick(30);
const sel = (id) => { document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })); };

// 1. "Keep its choices…" makes a log memory, every output wired to save
sel(dec.id);
const btn = [...document.querySelectorAll('.pc-inspector .pc-btn')].find(b => /Keep its choices/.test(b.textContent));
assert.ok(btn);
btn.click();
const mem = Object.values(g.nodes).find(n => n.type === 'memory');
assert.ok(mem, 'memory made');
const saves = Object.values(g.wires).filter(w => w.kind === 'save');
assert.deepEqual(saves.map(w => w.port).sort(), ['k1', 'k2']);
assert.ok(saves.every(w => w.from === dec.id && w.to === mem.id));
assert.match(document.querySelector('.pc-inspector').textContent, /when Mood chooses|Mood → Combat/);
assert.ok([...document.querySelectorAll('.pc-wire-label')].some(l => /save Combat/.test(l.textContent)), 'wire label names the output');

// 2. the save wire's settings
const w = saves.find(x => x.port === 'k1');
document.querySelector(`.pc-wire-hit[data-id="${w.id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
assert.match(document.querySelector('.pc-insp-title').textContent, /Save a decision into memory/);
assert.match(document.querySelector('.pc-inspector').textContent, /Whenever "Mood" chooses Combat/);
const what = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Save').querySelector('select');
what.value = 'matched'; what.dispatchEvent(new dom.window.Event('change'));
assert.equal(w.save, 'matched');
const w2 = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Save').querySelector('select');
w2.value = 'text'; w2.dispatchEvent(new dom.window.Event('change'));
const ta = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Text to save').querySelector('textarea');
ta.value = 'Fight: {{matched}}'; ta.dispatchEvent(new dom.window.Event('input'));
assert.equal(w.saveText, 'Fight: {{matched}}');

// 3. a Memory block can pick a Decider output to save from
S.disconnect(g, w.id);
sel(mem.id);
const pick = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Saved into it by').querySelector('select');
const opt = [...pick.options].find(o => o.textContent === 'when Mood chooses Combat');
assert.ok(opt, 'Decider outputs are offered');
assert.ok(![...pick.options].some(o => o.textContent === 'when Mood chooses Calm'), 'one already saving is not offered again');
pick.value = opt.value; pick.dispatchEvent(new dom.window.Event('change'));
assert.ok(Object.values(g.wires).some(x => x.kind === 'save' && x.port === 'k1'));
console.log('decider-memory-ui: ok');
