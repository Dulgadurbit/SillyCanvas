// The theme picker in the page: choosing a preset sets the colours, picking a
// colour changes it live, look-alike warnings appear, reset works, and the
// palette button opens the same editor over the canvas.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div><div id="drawer"></div></body>`, { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const { installMock } = await import('./mock.js');
const c = installMock({ settings: { graphs: {} } });
c.eventSource = { on() {}, emit() {} }; c.eventTypes = {};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const T = await import(`../src/theme.js?v=${v}`);
const E = await import(`../src/theme-editor.js?v=${v}`);
const UI = await import(`../src/ui.js?v=${v}`);
const root = document.documentElement;
const prop = (k) => root.style.getPropertyValue(`--pc-${k}`);

const box = document.getElementById('drawer');
E.renderThemeEditor(box);
const names = [...box.querySelectorAll('.pc-th-preset .pc-th-name')].map(n => n.textContent);
for (const want of ['SillyTavern', 'Midnight', 'Blueprint', 'Parchment', 'Neon', 'Terminal', 'Petal']) assert.ok(names.includes(want), want);
assert.equal(box.querySelectorAll('.pc-th-preset')[0].querySelectorAll('.pc-th-swatch').length, 7, 'swatches preview each theme');

// choose Blueprint
[...box.querySelectorAll('.pc-th-preset')].find(b => b.textContent.includes('Blueprint')).click();
assert.equal(T.currentTheme().preset, 'blueprint');
assert.equal(prop('panel'), T.PRESETS['blueprint'].colors.panel);
assert.equal(prop('generate'), T.PRESETS['blueprint'].colors.generate);
assert.ok([...box.querySelectorAll('.pc-th-preset.pc-on')].length === 1);

// the look is on the page: Blueprint is sharp, mono, a grid, right-angled wires
assert.equal(root.dataset.pcShape, 'sharp');
assert.equal(root.dataset.pcWires, 'angled');
assert.equal(root.dataset.pcGrid, 'lines');
assert.match(prop('font'), /monospace/);
assert.equal(root.dataset.pcOwn, '1', 'styles SillyTavern\u2019s controls in the panel');
// change the look in the editor
box.querySelector('.pc-th-look').open = true;
const shapeSel = [...box.querySelectorAll('.pc-th-look-select')].find(s => [...s.options].some(o => o.value === 'soft'));
shapeSel.value = 'soft'; shapeSel.dispatchEvent(new dom.window.Event('change'));
assert.equal(root.dataset.pcShape, 'soft');
assert.match(box.querySelector('.pc-th-look summary').textContent, /1 changed/);
T.setStyle('shape', null);

// Petal is light: text on colour pills flips to white
[...box.querySelectorAll('.pc-th-preset')].find(b => b.textContent.includes('Petal')).click();
assert.equal(root.dataset.pcLight, '1');
assert.equal(prop('on-accent'), '#ffffff');

// customise: pick a colour, see it live, get a look-alike warning, reset it
box.querySelector('.pc-th-custom').open = true;
const row = [...box.querySelectorAll('.pc-th-row')].find(r => r.textContent.includes('Append'));
const input = row.querySelector('input[type=color]');
input.value = T.PRESETS['petal'].colors.flow;               // same as Flow
input.dispatchEvent(new dom.window.Event('input'));
input.dispatchEvent(new dom.window.Event('change'));
assert.equal(T.currentTheme().custom.append, T.PRESETS['petal'].colors.flow);
assert.ok(box.querySelector('.pc-th-custom').open, 'stays open while editing');
assert.match(box.querySelector('.pc-th-warnings').textContent, /very close/);
assert.match(box.querySelector('.pc-th-custom summary').textContent, /1 changed/);
[...box.querySelectorAll('.pc-th-row')].find(r => r.textContent.includes('Append')).querySelector('.pc-th-reset').click();
assert.equal(T.currentTheme().custom.append, undefined);
assert.equal(box.querySelector('.pc-th-warnings'), null);

// export / import through the editor
T.setColor('decider', '#123456');
E.renderThemeEditor(box);
box.querySelector('.pc-th-share').open = true;
[...box.querySelectorAll('.pc-th-btn')].find(b => b.textContent === 'Copy my theme').click();
await new Promise(r => setTimeout(r, 10));
const shared = box.querySelector('.pc-th-text').value;
assert.match(shared, /sillyCanvasTheme/);
T.setPreset('midnight');
E.renderThemeEditor(box);
box.querySelector('.pc-th-text').value = shared;
[...box.querySelectorAll('.pc-th-btn')].find(b => b.textContent === 'Use pasted theme').click();
assert.equal(T.currentTheme().preset, 'petal');
assert.equal(T.currentTheme().custom.decider, '#123456');
assert.match(box.querySelector('.pc-th-msg').textContent, /Now using/);

// the palette button in the canvas opens the same editor
UI.open();
await new Promise(r => setTimeout(r, 30));
document.querySelector('.pc-theme-btn').click();
const pop = document.querySelector('.pc-theme-pop');
assert.ok(pop?.querySelector('.pc-th-preset'), 'popover shows the editor');
[...pop.querySelectorAll('.pc-th-preset')].find(b => b.textContent.includes('Parchment')).click();
assert.equal(T.currentTheme().preset, 'parchment');
assert.ok(box.querySelector('.pc-th-preset.pc-on').textContent.includes('Parchment'), 'the drawer editor follows');
document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
assert.equal(document.querySelector('.pc-theme-pop'), null, 'closes on a click outside');
console.log('theme-ui: ok');
