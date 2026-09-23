// onResult fires per block as it finishes (so answers can be shown while the
// rest run), and aborting cancels the remaining blocks with no retry and no send.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { parallel: false, concurrency: 2, graphs: {} } });

let calls = 0;
c.ChatCompletionService = {
    async processRequest(req, _o, _x, signal) {
        calls++;
        await new Promise((res, rej) => {
            const t = setTimeout(res, 30);
            signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        });
        return { choices: [{ message: { content: 'answer ' + calls }, finish_reason: 'stop' }] };
    },
};
const { run } = await import('../src/run.js');

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, enabled: true, role: 'system', thinking: 'off', ...extra });
const graph = () => ({
    nodes: {
        out: n('out', 'output', 900),
        q: n('q', 'prompt', 10, { content: 'Q', role: 'user' }),
        g1: n('g1', 'generate', 100, { content: 'one' }),
        g2: n('g2', 'generate', 200, { content: 'two' }),
        g3: n('g3', 'generate', 300, { content: 'three' }),
        fin: n('fin', 'prompt', 800, { content: 'FIN' }),
    },
    wires: {
        a: { id: 'a', from: 'q', to: 'g1', kind: 'merge' },
        b: { id: 'b', from: 'g1', to: 'g2', kind: 'merge' },   // chain: three waves
        d: { id: 'd', from: 'g2', to: 'g3', kind: 'merge' },
        e: { id: 'e', from: 'g3', to: 'fin', kind: 'merge' },
        f: { id: 'f', from: 'fin', to: 'out', kind: 'merge' },
    },
});

// 1. results arrive one by one, before run() returns
const seen = [];
const r1 = await run(graph(), { onResult: e => seen.push([e.id, e.text]) });
assert.deepEqual(seen.map(s => s[0]), ['g1', 'g2', 'g3']);
assert.equal(r1.plan.ok, true);
assert.equal(r1.plan.messages.at(-1).content, 'FIN');

// 2. abort during the second block: third never sent, no retry, no plan
calls = 0;
const ctrl = new AbortController();
const got = [];
const r2 = await run(graph(), {
    signal: ctrl.signal,
    onStage: (g) => { if (g.id === 'g2') setTimeout(() => ctrl.abort(), 5); },
    onResult: e => got.push(e.id),
});
assert.equal(r2.aborted, true);
assert.equal(r2.plan.ok, false);
assert.equal(calls, 2, 'g3 must not be sent and g2 must not be retried');
assert.deepEqual(got, ['g1']);

// 3. dry runs never call a model
calls = 0;
await run(graph(), { dryRun: true });
assert.equal(calls, 0);
console.log('live-and-stop: ok');
