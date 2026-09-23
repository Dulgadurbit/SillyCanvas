// The block trace must list blocks in the order the prompt sends them.
// Regression: a Generate block wired through a prompt block used to be listed
// after that block, although its answer is sent before it.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock();
const { collect } = await import('../src/compile.js');

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, enabled: true, role: 'system', ...extra });
const graph = {
    nodes: {
        out: n('out', 'output', 1200),
        sys: n('sys', 'prompt', 10, { content: 'SYS' }),
        hist: n('hist', 'prompt', 300, { content: 'HIST' }),
        think: n('think', 'prompt', 250, { content: 'THINK' }),
        gen1: n('gen1', 'generate', 540, { content: '' }),
        gen2: n('gen2', 'generate', 550, { content: '' }),
        final: n('final', 'prompt', 1050, { content: 'FINAL' }),
    },
    wires: {
        a: { id: 'a', from: 'sys', to: 'out', kind: 'merge' },
        b: { id: 'b', from: 'hist', to: 'out', kind: 'merge' },
        c: { id: 'c', from: 'final', to: 'out', kind: 'merge' },
        d: { id: 'd', from: 'think', to: 'gen1', kind: 'merge' },
        e: { id: 'e', from: 'think', to: 'gen2', kind: 'merge' },
        f: { id: 'f', from: 'gen1', to: 'final', kind: 'merge' },
        g: { id: 'g', from: 'gen2', to: 'final', kind: 'merge' },
    },
};
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const r = collect(graph, 'out', live, { gen1: 'ANS1', gen2: 'ANS2' });
assert.deepEqual(r.messages.map(m => m.content), ['SYS', 'HIST', 'ANS1', 'ANS2', 'FINAL']);
assert.deepEqual(r.trace.map(t => t.id), ['sys', 'hist', 'gen1', 'gen2', 'final']);

// Reading order is by the height of the block each message came from, even
// when it arrives through a block further down (the Kenzy canvas): System
// Prompt at the top goes first although it is wired in via the Thinking block.
{
    const g = {
        nodes: {
            gen: n('gen', 'generate', 650, { content: '' }),
            sys: n('sys', 'prompt', 17, { content: 'ROLE' }),
            desc: n('desc', 'prompt', 139, { content: 'DESC' }),
            hist: n('hist', 'prompt', 244, { content: 'HISTORY', role: 'user' }),
            think: n('think', 'prompt', 440, { content: 'TASK' }),
        },
        wires: {
            a: { id: 'a', from: 'sys', to: 'think', kind: 'merge' },
            b: { id: 'b', from: 'desc', to: 'think', kind: 'merge' },
            c: { id: 'c', from: 'think', to: 'gen', kind: 'merge' },
            d: { id: 'd', from: 'hist', to: 'gen', kind: 'merge' },
        },
    };
    const k = collect(g, 'gen', live, {});
    assert.deepEqual(k.messages.map(m => m.content), ['ROLE', 'DESC', 'HISTORY', 'TASK']);
    assert.deepEqual(k.trace.map(t => t.id), ['sys', 'desc', 'hist', 'think']);
    assert.ok(k.messages.every(m => !('__y' in m)), 'sort keys never leave the compiler');
    // a block's own text never goes above its inputs, wherever it sits
    g.nodes.think.y = 50;
    assert.deepEqual(collect(g, 'gen', live, {}).messages.map(m => m.content), ['ROLE', 'DESC', 'TASK', 'HISTORY']);
}

// A Generate block's closing system instruction goes out as the user turn.
{
    const { shapeForApi } = await import('../src/run.js');
    const msgs = [{ role: 'system', content: 'R' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'system', content: 'TASK' }];
    assert.equal(shapeForApi(msgs, { instructionAsUser: true }).messages.at(-1).role, 'user');
    assert.equal(shapeForApi(msgs, { instructionAsUser: false }).messages.at(-1).role, 'system');
    assert.equal(shapeForApi(msgs).messages.at(-1).role, 'system', 'the final send is untouched');
    assert.equal(msgs.at(-1).role, 'system', 'input not mutated');
}
console.log('trace-order: ok');
