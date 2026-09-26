// The model picker you can search: in a Generate block's settings, on the
// block itself, and for AI rules (which can also be answered by Jev).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div><select id="model_openrouter_select"><optgroup label="Anthropic"><option value="anthropic/claude-haiku">Claude Haiku</option><option value="anthropic/claude-opus">Claude Opus</option></optgroup><optgroup label="Google"><option value="google/gemini-flash">Gemini Flash</option></optgroup></select></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.chatCompletionSettings.chat_completion_source = 'openrouter';
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const key = (t, k) => t.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

const g = S.resolveGraph().graph;
const gen = Object.assign(S.addNode(g, 'generate', 100, 0), { title: 'Planner', content: 'Plan.' });
S.connect(g, gen.id, S.outputNode(g).id, 'merge');
const dec = Object.assign(S.addNode(g, 'decider', 400, 0), { title: 'Router', mode: 'all' });
dec.keys = [{ id: 'k1', name: 'Fight', conditions: [{ mode: 'ai', question: 'Is there a fight?' }] }];
g.view = { x: 0, y: 0, zoom: 1 };
UI.open();
await tick(30);
const sel = (id) => { document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })); };

// 1. the Generate block's settings: one search box
sel(gen.id);
const combo = () => document.querySelector('.pc-inspector .pc-combo');
let input = combo().querySelector('input');
input.dispatchEvent(new dom.window.Event('focus'));
let rows = [...combo().querySelectorAll('.pc-combo-row')].map(r => r.textContent);
assert.equal(rows.length, 4, 'same-as-connection + three models');
assert.match(rows[0], /same as the connection/);
assert.deepEqual([...combo().querySelectorAll('.pc-combo-group')].map(x => x.textContent), ['Anthropic', 'Google']);
input.value = 'claude opus'; input.dispatchEvent(new dom.window.Event('input'));
rows = [...combo().querySelectorAll('.pc-combo-row')].map(r => r.textContent);
assert.deepEqual(rows, ['Claude Opusanthropic/claude-opus', 'Use "claude opus" as the model id'], 'every word must match');
key(input, 'Enter');
assert.equal(gen.model, 'anthropic/claude-opus');
// a model id that is not listed can still be typed
input = combo().querySelector('input');
input.dispatchEvent(new dom.window.Event('focus'));
input.value = 'my/private-model'; input.dispatchEvent(new dom.window.Event('input'));
key(input, 'ArrowDown'); key(input, 'ArrowUp');
key(input, 'Enter');
assert.equal(gen.model, 'my/private-model');
// back to following the connection
input = combo().querySelector('input');
input.dispatchEvent(new dom.window.Event('focus'));
input.value = ''; input.dispatchEvent(new dom.window.Event('input'));
combo().querySelector('.pc-combo-same').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
assert.equal(gen.model, null);

// 2. on the canvas: click the model line on the block
const line = document.querySelector(`.pc-node[data-id="${gen.id}"] .pc-node-model-pick`);
assert.ok(line, 'the model line on a Generate block is clickable');
line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await tick();
const pop = document.querySelector('.pc-model-pop');
assert.ok(pop, 'a pop-up picker opens');
const pin = pop.querySelector('input');
pin.dispatchEvent(new dom.window.Event('focus'));
pin.value = 'flash'; pin.dispatchEvent(new dom.window.Event('input'));
key(pin, 'Enter');
assert.equal(gen.model, 'google/gemini-flash');
assert.ok(!document.querySelector('.pc-model-pop'), 'closes on a pick');
assert.match(document.querySelector(`.pc-node[data-id="${gen.id}"] .pc-node-model`).textContent, /google\/gemini-flash/);

// 3. an AI rule: a model you can search, or Jev
sel(dec.id);
const field = (label) => [...document.querySelectorAll('.pc-inspector .pc-field')].find(f => f.querySelector('.pc-label')?.textContent === label);
assert.ok(field('Model (optional)').querySelector('.pc-combo'), 'AI rule model is a search box');
const engine = field('Answered by').querySelector('select');
engine.value = 'jev'; engine.dispatchEvent(new dom.window.Event('change'));
assert.equal(dec.keys[0].conditions[0].engine, 'jev');
assert.ok(!field('Model (optional)'), 'no model to pick for Jev');
assert.match(document.querySelector('.pc-inspector').textContent, /Jev needs your TypeSafe API key/);
const thr = field('Counts as YES when Jev is').querySelector('input');
thr.value = '70'; thr.dispatchEvent(new dom.window.Event('input'));
assert.equal(dec.keys[0].conditions[0].threshold, 0.7);
assert.match(document.querySelector(`.pc-node[data-id="${dec.id}"]`).textContent, /Jev says yes/);

// 4. the AI sorter
const how = field('How it routes').querySelector('select');
how.value = 'ai'; how.dispatchEvent(new dom.window.Event('change'));
const eng2 = field('Answered by').querySelector('select');
eng2.value = 'jev'; eng2.dispatchEvent(new dom.window.Event('change'));
assert.equal(dec.sorter.engine, 'jev');
assert.match(document.querySelector(`.pc-node[data-id="${dec.id}"]`).textContent, /Jev picks the outputs/);
console.log('model-combo-ui: ok');
