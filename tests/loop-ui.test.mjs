// In the page: the new name, the Generate instruction hint, Repeat, and a
// loop made by dragging a wire back up, with its settings.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
const toasts = [];
globalThis.toastr = { info: m => toasts.push(m), warning: m => toasts.push(m), success() {}, error: m => toasts.push(m) };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

const g = S.resolveGraph().graph;
const task = Object.assign(S.addNode(g, 'prompt', 100, 0), { title: 'Task', content: 'Write a line.' });
const gen = Object.assign(S.addNode(g, 'generate', 100, 300), { title: 'Writer' });
S.connect(g, task.id, gen.id, 'merge'); S.connect(g, gen.id, S.outputNode(g).id, 'merge');
g.view = { x: 0, y: 0, zoom: 1 };
UI.open();
await tick(30);

// 1. the name
assert.match(document.querySelector('.pc-brand').textContent, /Silly Canvas/);
assert.ok(!document.body.textContent.includes('Prompt Canvas'));

// 2. the Generate face says where its instruction comes from
const genEl = () => document.querySelector(`.pc-node[data-id="${gen.id}"]`);
assert.match(genEl().querySelector('.pc-node-body').textContent, /1 wired block\. The last one, "Task", is the instruction/);
const select = (id) => { document.querySelector(`.pc-node[data-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })); };
select(gen.id);
const instr = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Instruction');
assert.ok(instr, 'field is called Instruction');
assert.match(instr.textContent, /Empty, so the last block wired in is the instruction: "Task"/);
const ta = instr.querySelector('textarea');
ta.value = 'List three beats.'; ta.dispatchEvent(new dom.window.Event('input'));
assert.match(instr.textContent, /Sent last, after the blocks wired in/);
assert.match(genEl().querySelector('.pc-node-body').textContent, /1 wired block, then "List three beats\."/);

// 3. Repeat
const passes = [...document.querySelectorAll('.pc-field')].find(f => f.querySelector('.pc-label')?.textContent === 'Passes').querySelector('input');
passes.value = '3'; passes.dispatchEvent(new dom.window.Event('change'));
assert.equal(gen.repeat, 3);
assert.match(genEl().textContent, /up to 3 passes, stops when nothing changes/);
assert.ok([...document.querySelectorAll('.pc-field .pc-label')].some(l => l.textContent === 'Ask on each extra pass'));

// 4. drag from the Writer's out port up onto Task: a loop, selected, with its settings
const port = genEl().querySelector('.pc-port-out:not(.pc-port-strip)');
document.elementFromPoint = () => document.querySelector(`.pc-node[data-id="${task.id}"]`);
port.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 230, clientY: 400 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, clientX: 230, clientY: 20 }));
await tick();
const loop = S.loopWires(g)[0];
assert.ok(loop, 'loop made');
assert.deepEqual(toasts, []);
assert.match(document.body.textContent, /After "Writer" answers, its answer goes back to "Task"/);
assert.ok(document.querySelector('.pc-wire-loop'), 'drawn as a loop');
assert.match(document.querySelector('.pc-wire-label-loop').textContent, /up to 3/);
const max = [...document.querySelectorAll('.pc-field')].find(f => /Run it again at most/.test(f.textContent)).querySelector('input');
max.value = '5'; max.dispatchEvent(new dom.window.Event('input'));
assert.equal(loop.loop.max, 5);
assert.match(document.querySelector('.pc-wire-label-loop').textContent, /up to 5/);
console.log('loop-ui: ok');
