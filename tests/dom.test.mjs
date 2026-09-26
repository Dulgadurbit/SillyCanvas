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
assert.ok(!box.querySelector('details').open, 'finished answer stays folded by default');
{
    const st = SillyTavern.getContext().extensionSettings['prompt-canvas'];
    st.ui = { ...(st.ui ?? {}), answersInChat: 'open' };
    livePanel.result({ id: 'g1', title: 'Scene', text: 'THE SCENE PLAN', show: true });
    assert.ok(box.querySelector('details').open, 'opens as it arrives when set to');
    st.ui.answersInChat = 'hidden';
    livePanel.running({ id: 'g3', title: 'Hidden' });
    assert.ok(![...box.querySelectorAll('summary')].some(x => /Hidden/.test(x.textContent)), 'hidden: not shown');
    delete st.ui.answersInChat;
}
livePanel.dropPending();
assert.equal(box.querySelectorAll('details').length, 1, 'stop keeps finished, drops spinners');
handlers.MESSAGE_RECEIVED.forEach(f => f(0));
assert.equal(document.querySelector('.pc-live'), null);
attachThoughts(0, [{ title: 'Scene', text: 'THE SCENE PLAN' }]);
assert.ok(document.querySelector('.mes .pc-thoughts').textContent.includes('THE SCENE PLAN'));
assert.equal(c.chat.length, 1, 'nothing added to chat[]');

// prompt inspector: present, built lazily, long text clipped with Show all
const long = 'x'.repeat(3000);
livePanel.result({ id: 'g9', title: 'Plan', text: 'P', show: true, prompt: [{ role: 'system', content: 'SYS' }, { role: 'user', content: long }] });
const insp = document.querySelector('.pc-live .pc-thought-prompt');
assert.ok(insp, 'inspector shown');
assert.match(insp.querySelector('summary').textContent, /2 messages, 3,003 characters/);
assert.equal(insp.querySelectorAll('.pc-tp-msg').length, 0, 'not built until opened');
insp.open = true; insp.dispatchEvent(new dom.window.Event('toggle'));
assert.equal(insp.querySelectorAll('.pc-tp-msg').length, 2);
assert.ok(insp.querySelector('.pc-tp-text:last-of-type, .pc-tp-msg:last-child .pc-tp-text').textContent.length < 1600);
insp.querySelector('.pc-tp-more').click();
assert.equal(insp.querySelector('.pc-tp-msg:last-child .pc-tp-text').textContent.length, 3000);
// attached to a message: inspector survives the fold, prompt not saved to the chat file
handlers.MESSAGE_RECEIVED.forEach(f => f(0));
attachThoughts(0, [{ title: 'Plan', text: 'P', prompt: [{ role: 'user', content: 'Q' }] }]);
assert.ok(document.querySelector('.mes .pc-thought-prompt'), 'inspector under reply');
assert.equal(c.chat[0].extra.promptCanvas.thoughts[0].prompt, undefined, 'prompt not persisted');

// a chat-completion send fires both hooks; only one may build
c.mainApi = 'openai';
const ev = { prompt: 'orig', dryRun: false };
c.extensionSettings['prompt-canvas'].enabled = true;
await Promise.all(handlers.GENERATE_AFTER_COMBINE_PROMPTS.map(f => f(ev)));
assert.equal(ev.prompt, 'orig', 'text hook stays out of chat completion');
console.log('dom: ok');
