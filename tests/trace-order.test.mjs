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
console.log('trace-order: ok');
