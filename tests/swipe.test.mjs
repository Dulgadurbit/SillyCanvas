// Swipes: the reply being replaced is left out of the canvas's prompt, like
// SillyTavern does, and you choose whether the Generate blocks run again or
// their earlier answers are kept. Quiet sends from other extensions are left alone.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<body><div id="chat"></div><div id="rightSendForm"><div id="send_but"></div></div></body>`);
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CSS: { escape: s => s }, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement });
const { installMock } = await import('./mock.js');
const handlers = {};
const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
const graph = {
    id: 'g', name: 'Swipe canvas',
    nodes: {
        out: n('out', 'output', 900),
        hist: n('hist', 'history', 0, { format: 'turns' }),
        plan: n('plan', 'generate', 300, { content: 'Plan the scene.' }),
    },
    wires: {},
};
const c = installMock({ settings: { enabled: true, graphs: { g: graph }, activeGraphId: 'g', ui: {} } });
const S = await import(`../src/state.js?v=${JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version}`);
S.connect(graph, 'hist', 'plan', 'merge'); S.connect(graph, 'hist', 'out', 'merge'); S.connect(graph, 'plan', 'out', 'merge');
c.eventSource = { on: (t, f) => (handlers[t] ??= []).push(f), emit() {} };
c.eventTypes = new Proxy({}, { get: (_, k) => k });
c.SlashCommandParser = { addCommandObject() {} }; c.SlashCommand = { fromProps: x => x };
c.saveChat = () => {};
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
const asked = [];
c.ChatCompletionService = {
    async processRequest(req) {
        asked.push(req.messages.map(m => m.content).join(' | '));
        return { choices: [{ message: { content: `PLAN ${asked.length}` }, finish_reason: 'stop' }] };
    },
};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { attachThoughts } = await import(`../src/thoughts.js?v=${v}`);
await import(`../index.js?v=${v}`);
await new Promise(r => setTimeout(r, 50));
const fire = async (type, ev) => { for (const f of handlers[type] ?? []) await f(...ev); };
const send = async (type) => {
    await fire('GENERATION_STARTED', [type, {}, false]);
    const data = { chat: [{ role: 'user', content: 'ST' }], dryRun: false };
    await fire('CHAT_COMPLETION_PROMPT_READY', [data]);
    return data.chat.map(m => m.content);
};

c.chat = [{ mes: 'Hello there', is_user: true, name: 'User', extra: {} }];
// 1. a normal send
let sent = await send('normal');
assert.equal(asked.length, 1);
assert.ok(sent.includes('Hello there'));
// the reply arrives, the answers are kept with it
c.chat.push({ mes: 'OLD REPLY', is_user: false, name: 'Char', extra: {} });
await fire('MESSAGE_RECEIVED', [1]);
assert.equal(c.chat[1].extra.promptCanvas.thoughts[0].id, 'plan', 'answers remember their block');

// 2. a swipe: the old reply is not in the prompt, and the canvas runs again
sent = await send('swipe');
assert.equal(asked.length, 2, 'Generate block asked again');
assert.ok(!sent.some(t => t.includes('OLD REPLY')), 'the reply being replaced is left out');
assert.ok(!asked[1].includes('OLD REPLY'), 'and the Generate block does not see it either');
assert.ok(sent.includes('PLAN 2'));
await fire('MESSAGE_RECEIVED', [1]);

// 3. swipe keeping the answers: no Generate call, the old answer is reused
c.extensionSettings['prompt-canvas'].swipeMode = 'reuse';
sent = await send('swipe');
assert.equal(asked.length, 2, 'not asked again');
assert.ok(sent.includes('PLAN 2'), 'the kept answer goes into the prompt');
assert.ok(!sent.some(t => t.includes('OLD REPLY')));
await fire('MESSAGE_RECEIVED', [1]);
assert.equal(c.chat[1].extra.promptCanvas.thoughts[0].kept, true, 'shown under the new reply as kept');

// 4. a quiet send (another extension, /gen) keeps its own prompt
sent = await send('quiet');
assert.deepEqual(sent, ['ST']);
assert.equal(asked.length, 2);
console.log('swipe: ok');
