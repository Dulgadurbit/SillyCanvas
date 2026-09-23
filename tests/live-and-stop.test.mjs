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

// 4. provider refuses simultaneous requests: parallel pair fails, each works
//    alone -> both answered, limit dropped to one, run reports throttled
let inFlight = 0;
const live = new Set();
c.ChatCompletionService.processRequest = async () => {
    const me = { overlapped: inFlight > 0 };
    for (const o of live) o.overlapped = true;
    live.add(me); inFlight++;
    await new Promise(r => setTimeout(r, 10));
    live.delete(me); inFlight--;
    const busy = me.overlapped;
    if (busy) throw new Error('429 too many concurrent requests');
    return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
};
const par = {
    nodes: {
        out: n('out', 'output', 900),
        q: n('q', 'prompt', 10, { content: 'Q', role: 'user' }),
        a1: n('a1', 'generate', 100, { content: 'a' }),
        a2: n('a2', 'generate', 100, { content: 'b' }),
    },
    wires: {
        w1: { id: 'w1', from: 'q', to: 'a1', kind: 'merge' },
        w2: { id: 'w2', from: 'q', to: 'a2', kind: 'merge' },
        w3: { id: 'w3', from: 'a1', to: 'out', kind: 'merge' },
        w4: { id: 'w4', from: 'a2', to: 'out', kind: 'merge' },
    },
};
c.extensionSettings['prompt-canvas'].concurrency = 2;
const r4 = await run(par);
assert.equal(r4.throttled, true);
assert.equal(r4.failures.length, 0);
assert.equal(c.extensionSettings['prompt-canvas'].concurrency, 1);
assert.deepEqual(r4.plan.messages.map(m => m.content), ['ok', 'ok']);
// the inspector gets exactly what was sent
assert.ok(r4.thoughts.every(t => Array.isArray(t.prompt) && t.prompt.length));
console.log('live-and-stop: ok');
