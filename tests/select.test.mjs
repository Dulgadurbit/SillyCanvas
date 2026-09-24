// "Send what?" — a wire filter picks exactly which messages, and which part
// of their text, cross a wire.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const Sel = await import(`../src/select.js?v=${v}`);
const { collect, evaluateDecider, tryDecide, wirePreview } = await import(`../src/compile.js?v=${v}`);

// ---- parseNumbers ----
assert.deepEqual([...Sel.parseNumbers('23, 25 #30-32, junk, 5-3')].sort((a, b) => a - b), [3, 4, 5, 23, 25, 30, 31, 32]);

// ---- applySelect on its own ----
const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1', __idx: 1 },
    { role: 'assistant', content: 'c1\n\npara two', __idx: 2 },
    { role: 'user', content: 'u2', __idx: 3 },
    { role: 'assistant', content: '<think>hmm</think>c2 <plan>go north</plan>', __idx: 4 },
];
const T = (sel) => Sel.applySelect(msgs, sel).map(m => m.content);
assert.deepEqual(T(null), msgs.map(m => m.content), 'no filter: everything');
assert.deepEqual(T({}), msgs.map(m => m.content), 'all-default filter: everything');
assert.equal(Sel.isActive({ count: 'all', who: 'any' }), false);
assert.deepEqual(T({ count: 'last', n: 2 }), ['u2', '<think>hmm</think>c2 <plan>go north</plan>']);
assert.deepEqual(T({ count: 'first', n: 1 }), ['sys']);
assert.deepEqual(T({ who: 'user' }), ['u1', 'u2']);
assert.deepEqual(T({ who: 'char', count: 'last', n: 1, skip: 1 }), ['c1\n\npara two'], 'last char reply before the newest');
assert.deepEqual(T({ numbers: '1, 4' }).length, 2);
assert.deepEqual(T({ numbers: '2-3' }), ['c1\n\npara two', 'u2']);
assert.deepEqual(T({ stripThinking: true, count: 'last', n: 1 }), ['c2 <plan>go north</plan>']);
assert.deepEqual(T({ between: 'plan' }), ['go north'], 'only messages that have the tag survive');
assert.deepEqual(T({ between: '<plan>' }), ['go north'], 'tag typed with brackets works too');
assert.deepEqual(T({ numbers: '2', keep: 'lastPara', paras: 1 }), ['para two']);
const joined = Sel.applySelect(msgs, { who: 'user', join: true, labels: true }, { name1: 'Hanno', name2: 'Kenzy' });
assert.equal(joined.length, 1);
assert.equal(joined[0].content, 'Hanno: u1\n\nHanno: u2');
assert.equal(Sel.selectLabel({ count: 'last', n: 5, who: 'user' }), 'last 5 · user');
assert.equal(Sel.selectLabel({}), '');
assert.deepEqual(T({ count: 'last', n: 0 }), [], 'last 0 is nothing');

// ---- through the compiler ----
const chat = [
    { is_user: true, mes: 'I open the door.', name: 'Hanno' },          // #0
    { is_user: false, mes: 'The hall is red with lanterns.', name: 'Kenzy' }, // #1
    { is_system: true, mes: 'hidden note' },                             // #2
    { is_user: true, mes: 'I step inside.', name: 'Hanno' },             // #3
    { is_user: false, mes: 'A blue light flickers.', name: 'Kenzy' },    // #4
];
const live = { chat, substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {}, name1: 'Hanno', name2: 'Kenzy' };
const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', ...extra });
const g = {
    nodes: {
        sys: n('sys', 'prompt', 0, { content: 'SYSTEM' }),
        hist: n('hist', 'history', 100, { count: 0, skip: 0 }),
        out: n('out', 'output', 900),
    },
    wires: {
        w1: { id: 'w1', from: 'sys', to: 'out', kind: 'merge' },
        w2: { id: 'w2', from: 'hist', to: 'out', kind: 'merge' },
    },
};
let r = collect(g, 'out', live);
assert.equal(r.messages.length, 5, 'unfiltered: system + 4 chat');
assert.ok(r.messages.every(m => !('__idx' in m) && !('__speaker' in m)), 'internal fields never leave');

g.wires.w2.select = { who: 'char', count: 'last', n: 1 };
r = collect(g, 'out', live);
assert.deepEqual(r.messages.map(m => m.content), ['SYSTEM', 'A blue light flickers.']);

g.wires.w2.select = { numbers: '1, 3' };
r = collect(g, 'out', live);
assert.deepEqual(r.messages.map(m => m.content), ['SYSTEM', 'The hall is red with lanterns.', 'I step inside.'], 'numbers are SillyTavern message numbers');

// the same History block feeding two places, filtered differently
g.nodes.p = n('p', 'prompt', 500, { content: 'Recap:' });
g.wires.w3 = { id: 'w3', from: 'hist', to: 'p', kind: 'append', select: { who: 'user', join: true } };
g.wires.w4 = { id: 'w4', from: 'p', to: 'out', kind: 'merge' };
g.wires.w2.select = null;
r = collect(g, 'out', live);
assert.equal(r.messages.at(-1).content, 'Recap:\n\nI open the door.\n\nI step inside.');
assert.equal(r.messages.length, 6);

// preview of one wire
const pv = wirePreview(g, g.wires.w3, live);
assert.deepEqual(pv, [{ role: 'system', content: 'I open the door.\n\nI step inside.' }]);

// ---- a Decider only sees what its wire lets through ----
const d = {
    nodes: {
        hist: n('hist', 'history', 0, { count: 0, skip: 0 }),
        dec: n('dec', 'decider', 200, {
            mode: 'rules',
            keys: [{ id: 'kr', name: 'Red', match: 'any', conditions: [{ mode: 'search', scope: 'incoming', terms: 'red' }] }],
            fallback: { id: 'kf', name: 'Otherwise' },
        }),
        a: n('a', 'prompt', 400, { content: 'RED PATH' }),
        b: n('b', 'prompt', 400, { content: 'OTHER PATH' }),
        out: n('out', 'output', 900),
    },
    wires: {
        w1: { id: 'w1', from: 'hist', to: 'dec', kind: 'merge' },
        w2: { id: 'w2', from: 'dec', to: 'a', kind: 'merge', port: 'kr' },
        w3: { id: 'w3', from: 'dec', to: 'b', kind: 'merge', port: 'kf' },
        w4: { id: 'w4', from: 'a', to: 'out', kind: 'merge' },
        w5: { id: 'w5', from: 'b', to: 'out', kind: 'merge' },
    },
};
assert.equal(tryDecide(d, d.nodes.dec, live, {}, {}).name, 'Red', 'whole chat mentions red');
d.wires.w1.select = { count: 'last', n: 1 };
assert.equal(tryDecide(d, d.nodes.dec, live, {}, {}).name, 'Otherwise', 'the last message alone does not');

console.log('select: ok');
