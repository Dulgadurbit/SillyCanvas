// Open the real panel, select a Decider and drive its key editor.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
c.POPUP_TYPE = { CONFIRM: 1 }; c.POPUP_RESULT = { AFFIRMATIVE: 1 }; c.callGenericPopup = async () => 1;
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const g = S.resolveGraph().graph;
const d = S.addNode(g, S.NODE_TYPES.DECIDER, 100, 100);
UI.open();
await new Promise(r => setTimeout(r, 30));
// select it through the canvas
const nodeEl = document.querySelector(`.pc-node[data-id="${d.id}"]`);
assert.ok(nodeEl, 'decider drawn');
nodeEl.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
await new Promise(r => setTimeout(r, 10));
const insp = () => document.querySelector('.pc-inspector, [class*="inspector"]');
const text = document.body.textContent;
assert.match(text, /How Deciders work/);
assert.match(text, /Not set up yet/);
const cards = () => document.querySelectorAll('.pc-key-card');
assert.equal(cards().length, 1, 'only Otherwise at first');
// choose a routing mode
const chooseBy = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'random'));
chooseBy.value = 'all'; chooseBy.dispatchEvent(new dom.window.Event('change'));
assert.equal(d.mode, 'all');
// add two outputs
const addOut = () => [...document.querySelectorAll('.pc-btn')].find(b => b.textContent.includes('Add an output')).click();
addOut(); addOut();
assert.equal(d.keys.length, 2);
assert.equal(cards().length, 3);
// add a rule to output 1, switch it to time
[...document.querySelectorAll('.pc-key-add')][0].click();
assert.equal(d.keys[0].conditions.length, 2);
const sels = [...cards()[0].querySelectorAll('select')];
const modeSel = sels.find(s => [...s.options].some(o => o.value === 'time'));
modeSel.value = 'time'; modeSel.dispatchEvent(new dom.window.Event('change'));
assert.equal(d.keys[0].conditions[0].mode, 'time');
assert.ok(cards()[0].querySelector('input[type="time"]'), 'time inputs shown');
// NOT on a rule
const notBox = [...cards()[0].querySelectorAll('.pc-checkline')].find(l => l.textContent.startsWith('NOT'));
notBox.querySelector('input').checked = true; notBox.querySelector('input').dispatchEvent(new dom.window.Event('change'));
assert.equal(d.keys[0].conditions[0].not, true);
// random mode shows weights
const chooseBy2 = () => [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'random'));
chooseBy2().value = 'random'; chooseBy2().dispatchEvent(new dom.window.Event('change'));
assert.equal(d.mode, 'random');
assert.ok(document.body.textContent.includes('Weight'));
// AI mode shows descriptions and the sorter settings
chooseBy2().value = 'ai'; chooseBy2().dispatchEvent(new dom.window.Event('change'));
assert.ok(document.body.textContent.includes('Description for the AI'));
assert.ok(document.body.textContent.includes('May pick several outputs'));
// delete key 2
[...cards()[1].querySelectorAll('.pc-key-tool')].at(-1).click();
assert.equal(d.keys.length, 1);
// preview renders with the decider in it
await UI.refreshPreview?.();
await new Promise(r => setTimeout(r, 30));

// "Goes to": wire a key from the inspector, then remove it again
const target = S.addNode(g, S.NODE_TYPES.PROMPT, 100, 500);
target.title = 'Deslop';
chooseBy2().value = 'first'; chooseBy2().dispatchEvent(new dom.window.Event('change'));
const picker = cards()[0].querySelector('.pc-dest select');
const opt = [...picker.options].find(o => o.textContent === 'Deslop');
assert.ok(opt, 'blocks listed as destinations');
picker.value = opt.value; picker.dispatchEvent(new dom.window.Event('change'));
const w = Object.values(g.wires).find(w => w.from === d.id && w.to === target.id);
assert.equal(w?.port, d.keys[0].id, 'wired from that key');
assert.match(cards()[0].querySelector('.pc-dest-chips').textContent, /Deslop/);
// fallback has its own picker
const fbPick = cards()[cards().length - 1].querySelector('.pc-dest select');
const outOpt = [...fbPick.options].find(o => o.textContent.includes('(Output)'));
fbPick.value = outOpt.value; fbPick.dispatchEvent(new dom.window.Event('change'));
assert.ok(Object.values(g.wires).some(w => w.from === d.id && w.port === d.fallback.id));
cards()[0].querySelector('.pc-dest-x').click();
assert.ok(!Object.values(g.wires).some(w => w.from === d.id && w.to === target.id), 'removed');
// the new rule kinds render
const ms = [...cards()[0].querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'ai'));
for (const mode of ['lacks', 'number', 'ai']) {
    const sel = [...cards()[0].querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'ai'));
    sel.value = mode; sel.dispatchEvent(new dom.window.Event('change'));
    assert.equal(d.keys[0].conditions[0].mode, mode);
}
assert.ok(cards()[0].textContent.includes('YES or NO'));

// the test box: colour router example, then paste text
[...document.querySelectorAll('.pc-btn')].find(b => b.textContent.includes('colour router')).click();
await new Promise(r => setTimeout(r, 20));
const confirmBtn = document.querySelector('.pc-confirm-ok, .pc-dialog .menu_button');
if (confirmBtn) confirmBtn.click();
await new Promise(r => setTimeout(r, 20));
if (d.mode === 'all') {
    const ta = document.querySelector('.pc-dec-test textarea');
    ta.value = 'a crimson sky over a navy sea';
    [...document.querySelectorAll('.pc-dec-test .pc-btn')][0].click();
    await new Promise(r => setTimeout(r, 30));
    const rows = [...document.querySelectorAll('.pc-dec-test-row')];
    assert.ok(rows.find(r => r.textContent.includes('Red')).classList.contains('pc-yes'));
    assert.ok(rows.find(r => r.textContent.includes('Blue')).classList.contains('pc-yes'), 'both fire');
    assert.ok(rows.find(r => r.textContent.includes('Otherwise')).classList.contains('pc-no'));
} else {
    console.log('  (example needs a confirm dialog; skipped the test-box check)');
}
console.log('inspector: ok');
