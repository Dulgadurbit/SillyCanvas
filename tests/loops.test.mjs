// Repeat passes on a Generate block, loop-back wires with a limit, stopping
// early when nothing changes, and a Decider's looping key taken away once
// its loop has run out.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });
const calls = [];
let reply = () => 'x';
c.ChatCompletionService = { async processRequest(req) { calls.push(req.messages); return { choices: [{ message: { content: reply(req.messages, calls.length) }, finish_reason: 'stop' }] }; } };
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run, maxCalls } = await import(`../src/run.js?v=${v}`);
const { compile } = await import(`../src/compile.js?v=${v}`);
const { connect, loopWires } = await import(`../src/state.js?v=${v}`);
const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const w = (g, a, b, opts) => { const r = connect(g, a, b, 'merge', opts); assert.ok(r.ok, r.reason); return r.wire; };

// ---------- 1. Repeat: each pass works on the last answer
{
    const g = { nodes: { out: n('out', 'output', 900), draft: n('draft', 'prompt', 0, { content: 'DRAFT with slop slop slop', role: 'user' }),
        clean: n('clean', 'generate', 200, { content: 'Remove one slop.', repeat: 3 }) }, wires: {} };
    w(g, 'draft', 'clean'); w(g, 'clean', 'out');
    calls.length = 0;
    reply = (m) => { const last = [...m].reverse().find(x => x.role === 'assistant')?.content ?? 'DRAFT with slop slop slop'; return last.replace(/ slop$/, ''); };
    const seen = [];
    const r = await run(g, { onResult: e => seen.push(e.title) });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].at(-2).role, 'assistant', 'pass 2 is shown its last answer');
    assert.equal(calls[1].at(-2).content, 'DRAFT with slop slop');
    assert.equal(calls[1].at(-1).content, 'Remove one slop.', 'and asked the same thing again');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['DRAFT with']);
    assert.deepEqual(seen, ['clean (pass 1 of 3)', 'clean (pass 2 of 3)', 'clean (pass 3 of 3)']);
    assert.equal(maxCalls(g), 3);

    // stops early when a pass changes nothing
    calls.length = 0;
    g.nodes.clean.repeat = 5;
    reply = () => 'already clean';
    const r2 = await run(g);
    assert.equal(calls.length, 2, 'second pass matched the first, so it stopped');
    assert.match(r2.thoughts[0].title, /nothing left to change/);
}

// ---------- 2. connect: loops only from Generate blocks or Decider keys
{
    const g = { nodes: { out: n('out', 'output', 900), a: n('a', 'prompt', 0, { content: 'A' }), b: n('b', 'prompt', 100, { content: 'B' }), gen: n('gen', 'generate', 200) }, wires: {} };
    w(g, 'a', 'b'); w(g, 'b', 'gen'); w(g, 'gen', 'out');
    const bad = connect(g, 'b', 'a', 'merge');
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /Only a Generate block/);
    const self = connect(g, 'gen', 'gen', 'merge');
    assert.match(self.reason, /Repeat/);
    const loop = w(g, 'gen', 'a');
    assert.deepEqual(loop.loop, { max: 3, stopWhenSame: true });
    // the picture ignores it: preview, order and reach are unchanged
    const p = await compile(g, { dryRun: true, live });
    assert.equal(p.ok, true);
    assert.equal(maxCalls(g), 1 + 3, 'up to: once, plus three loops');
}

// ---------- 3. A Generate loop runs its section again with the last result
{
    const g = { nodes: { out: n('out', 'output', 900), task: n('task', 'prompt', 0, { content: 'Write a line.', role: 'user' }),
        write: n('write', 'generate', 200) }, wires: {} };
    w(g, 'task', 'write'); w(g, 'write', 'out');
    const lw = w(g, 'write', 'task');
    lw.loop.max = 2;
    calls.length = 0;
    reply = (m, i) => `line ${i}`;
    const r = await run(g);
    assert.equal(calls.length, 3, 'first run + 2 loops');
    assert.match(calls[1].map(x => x.content).join('|'), /previous attempt[\s\S]*line 1/i, 'loop hands back the last result');
    assert.match(calls[2].map(x => x.content).join('|'), /line 2/);
    assert.deepEqual(r.plan.messages.map(m => m.content), ['line 3']);
    assert.match(r.thoughts[0].title, /attempt 3/);

    // stop early: a loop whose result stops changing ends
    calls.length = 0;
    lw.loop.max = 5;
    reply = () => 'the same line';
    await run(g);
    assert.equal(calls.length, 2, 'second result matched the first');
}

// ---------- 4. Decider loop: NO goes back up, YES goes on; limit removes NO
{
    const mk = () => {
        const g = { nodes: {
            out: n('out', 'output', 900),
            task: n('task', 'prompt', 0, { content: 'Write it.', role: 'user' }),
            write: n('write', 'generate', 100),
            check: n('check', 'decider', 250, { mode: 'rules', keys: [{ id: 'no', name: 'NO', conditions: [{ mode: 'search', scope: 'incoming', terms: 'Elara' }] }], fallback: { id: 'yes', name: 'YES' } }),
        }, wires: {} };
        w(g, 'task', 'write'); w(g, 'write', 'check');
        w(g, 'check', 'out', { port: 'yes' });
        const back = w(g, 'check', 'task', { port: 'no' });
        return { g, back };
    };
    // fixed on the second try
    let { g } = mk();
    calls.length = 0;
    reply = (m, i) => (i === 1 ? 'Elara smiled.' : 'Mira smiled.');
    let seen = [];
    let r = await run(g, { onResult: e => seen.push(e.label ?? e.title) });
    assert.equal(calls.length, 2);
    assert.match(calls[1].map(x => x.content).join('|'), /Elara smiled/, 'the rejected draft comes back');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['Mira smiled.']);
    assert.ok(seen.includes('check → NO') && seen.some(s => /check → YES \(attempt 2\)/.test(s)));

    // never fixed: after the limit the NO key is taken away and YES wins
    ({ g } = mk());
    g.wires[Object.keys(g.wires).find(k => g.wires[k].loop)].loop.max = 2;
    calls.length = 0;
    reply = () => 'Elara again.';
    r = await run(g);
    assert.equal(calls.length, 3, 'first try + 2 loops, then no more');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['Elara again.']);
    assert.ok(r.thoughts.find(t => t.decision)?.label.includes('YES'));
}

// ---------- 5. a stopped loop costs nothing more
{
    const g = { nodes: { out: n('out', 'output', 900), task: n('task', 'prompt', 0, { content: 'go', role: 'user' }), write: n('write', 'generate', 200) }, wires: {} };
    w(g, 'task', 'write'); w(g, 'write', 'out');
    w(g, 'write', 'task').loop.max = 10;
    calls.length = 0;
    const ctrl = new AbortController();
    reply = (m, i) => { if (i === 2) ctrl.abort(); return `v${i}`; };
    const r = await run(g, { signal: ctrl.signal });
    assert.equal(r.aborted, true);
    assert.ok(calls.length <= 2);
}

// ---------- 6. a Decider key that only loops is not reported as unwired
{
    const g = { nodes: { out: n('out', 'output', 900), task: n('task', 'prompt', 0, { content: 'go', role: 'user' }), write: n('write', 'generate', 100),
        check: n('check', 'decider', 250, { mode: 'rules', keys: [{ id: 'no', name: 'NO', conditions: [{ mode: 'search', scope: 'incoming', terms: 'x' }] }], fallback: { id: 'yes', name: 'YES' } }) }, wires: {} };
    w(g, 'task', 'write'); w(g, 'write', 'check'); w(g, 'check', 'out', { port: 'yes' }); w(g, 'check', 'task', { port: 'no' });
    const p = await compile(g, { dryRun: true, live });
    assert.ok(!p.warnings.some(x => /NO" is not wired/.test(x)), p.warnings.join('\n'));
}
console.log('loops: ok');
