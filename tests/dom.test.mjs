// DOM checks for the chat-bar button and the live Generate panel.
// Needs jsdom, which the extension itself does not: `npm i jsdom` somewhere
// on your NODE_PATH, then `node tests/dom.test.mjs`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"><div class="mes" mesid="0"><div class="mes_block"><div class="mes_text">hi</div></div></div></div>
<div id="rightSendForm"><div id="mes_stop"></div><div id="send_but"></div></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement });
const { installMock } = await import('./mock.js');
const handlers = {};
const c = installMock({ settings: { enabled: true, graphs: { g: { id: 'g', name: 'Test canvas', nodes: {}, wires: {} } }, activeGraphId: 'g', ui: {} } });
c.eventSource = { on: (t, f) => (handlers[t] ??= []).push(f), emit() {} };
c.eventTypes = new Proxy({}, { get: (_, k) => k });
c.SlashCommandParser = { addCommandObject() {} }; c.SlashCommand = { fromProps: x => x };
c.chat = [{ mes: 'hi', extra: {} }]; c.saveChat = () => {};
globalThis.toastr = { info() {}, warning() {}, success() {} };

const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { livePanel, attachThoughts } = await import(`../src/thoughts.js?v=${v}`);
await import(`../index.js?v=${v}`);
await new Promise(r => setTimeout(r, 50));

const b = document.getElementById('pc-sendbar');
assert.ok(b, 'button mounted');
assert.equal(b.nextElementSibling.id, 'send_but', 'sits right before Send');
assert.ok(b.classList.contains('pc-sendbar-on'));
assert.match(b.title, /"Test canvas"/);
b.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
assert.equal(c.extensionSettings['prompt-canvas'].enabled, false, 'right-click disarms');
assert.ok(!b.classList.contains('pc-sendbar-on'));

livePanel.running({ id: 'g1', title: 'Scene' });
livePanel.running({ id: 'g2', title: 'Characters' });
const box = document.querySelector('#chat > .pc-live');
assert.ok(box, 'panel in chat');
assert.equal(box.querySelectorAll('.pc-thought-pending').length, 2);
livePanel.result({ id: 'g1', title: 'Scene', text: 'THE SCENE PLAN', show: true });
assert.equal(box.querySelectorAll('.pc-thought-pending').length, 1);
assert.ok(box.querySelector('details').open, 'finished answer opens');
livePanel.dropPending();
assert.equal(box.querySelectorAll('details').length, 1, 'stop keeps finished, drops spinners');
handlers.MESSAGE_RECEIVED.forEach(f => f(0));
assert.equal(document.querySelector('.pc-live'), null);
attachThoughts(0, [{ title: 'Scene', text: 'THE SCENE PLAN' }]);
assert.ok(document.querySelector('.mes .pc-thoughts').textContent.includes('THE SCENE PLAN'));
assert.equal(c.chat.length, 1, 'nothing added to chat[]');
console.log('dom: ok');
