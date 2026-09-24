// Decider in rules mode: picks one path, the others cost nothing and send
// nothing, rules read the text coming in, and the preview is honest about
// what it cannot know yet.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });

const asked = [];
c.ChatCompletionService = {
    async processRequest(req) {
        const q = req.messages.map(m => m.content).join(' | ');
        asked.push(q);
        await new Promise(r => setTimeout(r, 5));
        if (q.includes('WRITE')) return { choices: [{ message: { content: globalThis.draft }, finish_reason: 'stop' }] };
        if (q.includes('DESLOP')) return { choices: [{ message: { content: 'clean draft' }, finish_reason: 'stop' }] };
        return { choices: [{ message: { content: 'other' }, finish_reason: 'stop' }] };
    },
};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run } = await import(`../src/run.js?v=${v}`);
const { compile, evaluateDecider, emissionCounts } = await import(`../src/compile.js?v=${v}`);
const { connect, removeDeciderKey } = await import(`../src/state.js?v=${v}`);

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {}, name2: 'Kenzy' };

// Draft -> Decider(DESLOP if "Elara") -> DESLOP: Deslop gen -> Output
//                                     -> Otherwise: straight to Output
function graph() {
    const g = {
        nodes: {
            out: n('out', 'output', 900),
            q: n('q', 'prompt', 0, { content: 'WRITE', role: 'user' }),
            draft: n('draft', 'generate', 100, { content: '' }),
            dec: n('dec', 'decider', 250, {
                mode: 'rules',
                keys: [{ id: 'k1', name: 'DESLOP', match: 'any', conditions: [{ mode: 'search', scope: 'incoming', terms: 'Elara\nbarely above a whisper' }] }],
                fallback: { id: 'kf', name: 'Otherwise' },
            }),
            fix: n('fix', 'generate', 450, { content: 'DESLOP this' }),
        },
        wires: {},
    };
    const w = (a, b, port) => { const r = connect(g, a, b, 'merge', port ? { port } : {}); assert.ok(r.ok, r.reason); };
    w('q', 'draft'); w('draft', 'dec'); w('dec', 'fix', 'k1'); w('dec', 'out', 'kf'); w('fix', 'out');
    return g;
}

// connect: a Decider wire must name a key
{
    const g = graph();
    assert.equal(connect(g, 'dec', 'fix', 'merge').ok, false);
    assert.equal(connect(g, 'dec', 'fix', 'merge', { port: 'k1' }).ok, false, 'duplicate refused');
}

// 1. slop present -> DESLOP path runs, draft is NOT sent straight through
globalThis.draft = 'Elara smiled, barely above a whisper.';
asked.length = 0;
let seen = [];
let r = await run(graph(), { onResult: e => seen.push(e) });
assert.equal(asked.length, 2, 'draft + deslop');
assert.deepEqual(r.plan.messages.map(m => m.content), ['clean draft']);
const dec = seen.find(e => e.decision);
assert.equal(dec.label, 'dec → DESLOP');
assert.match(dec.text, /"Elara"/);
assert.ok(r.plan.trace.some(t => t.id === 'dec' && [].concat(t.decision).includes('k1')));

// 2. clean -> fallback path, the Deslop block is never called
globalThis.draft = 'She laughed.';
asked.length = 0;
r = await run(graph());
assert.equal(asked.length, 1, 'deslop not called on the path not taken');
assert.deepEqual(r.plan.messages.map(m => m.content), ['She laughed.']);
assert.equal(r.plan.stages.filter(s => !s.final).length, 1, 'plan lists only calls that ran');

// 3. preview before anything ran: follows fallback and says so
const p = await compile(graph(), { dryRun: true, live });
const t = p.trace.find(x => x.id === 'dec');
assert.equal(t.status, 'pending');
assert.match(t.why, /send time/);

// 4. rules that read the chat are decided exactly in the preview
{
    const g = graph();
    g.nodes.dec.keys[0].conditions = [{ mode: 'chat', what: 'messages', op: 'gte', value: 2 }];
    const liveChat = { ...live, chat: [{ mes: 'a', is_user: true }, { mes: 'b' }] };
    const pp = await compile(g, { dryRun: true, live: liveChat });
    const tt = pp.trace.find(x => x.id === 'dec');
    assert.equal(tt.status, 'in');
    assert.deepEqual(tt.decision, ['k1']);
}

// 5. evaluation details
const d = (keys, extra = {}) => evaluateDecider({ mode: 'rules', keys, fallback: { id: 'f', name: 'Otherwise' }, enabled: true, ...extra }, live, 'The quick brown fox');
assert.equal(d([{ id: 'a', name: 'A', conditions: [{ mode: 'search', scope: 'incoming', terms: '' }] }]).key, 'f', 'empty terms never match');
assert.equal(d([{ id: 'a', name: 'A', conditions: [{ mode: 'length', op: 'gt', value: 3 }] }]).key, 'a');
assert.equal(d([{ id: 'a', name: 'A', match: 'all', conditions: [{ mode: 'search', scope: 'incoming', terms: 'fox' }, { mode: 'length', op: 'gt', value: 10 }] }]).key, 'f', 'all must hold');
assert.equal(d([{ id: 'a', name: 'A', conditions: [{ mode: 'character', value: 'kenz' }] }]).key, 'a');
assert.equal(d([{ id: 'a', name: 'A', conditions: [{ mode: 'always' }] }], { enabled: false }).key, 'f', 'off -> fallback');
// first matching key wins
assert.equal(d([
    { id: 'a', name: 'A', conditions: [{ mode: 'search', scope: 'incoming', terms: 'fox' }] },
    { id: 'b', name: 'B', conditions: [{ mode: 'search', scope: 'incoming', terms: 'quick' }] },
]).key, 'a');
// weighted random
const rnd = (x) => evaluateDecider({ mode: 'random', keys: [{ id: 'a', name: 'A', weight: 3 }], fallback: { id: 'f', name: 'F', weight: 1 }, enabled: true }, live, '', { random: () => x });
assert.equal(rnd(0.5).key, 'a'); assert.equal(rnd(0.9).key, 'f');
// time window across midnight
const at = (h) => evaluateDecider({ mode: 'rules', keys: [{ id: 'n', name: 'Night', conditions: [{ mode: 'time', from: '22:00', to: '06:00' }] }], fallback: { id: 'f' }, enabled: true }, live, '', { now: new Date(2026, 0, 1, h, 0) }).key;
assert.equal(at(23), 'n'); assert.equal(at(3), 'n'); assert.equal(at(12), 'f');

// 6. alternatives are not counted as the text being sent twice
{
    const g = graph();
    connect(g, 'dec', 'out', 'merge', { port: 'k1' });
    assert.equal(emissionCounts(g).get('draft'), 1);
}

// 7. removing a key removes its wires
{
    const g = graph();
    removeDeciderKey(g, g.nodes.dec, 'k1');
    assert.ok(!Object.values(g.wires).some(w => w.port === 'k1'));
}

// 8. a chat rule decides before anything runs, so the untaken branch's
//    Generate block is never called even though it has no other inputs
{
    const g = {
        nodes: {
            out: n('out', 'output', 900),
            dec: n('dec', 'decider', 100, { mode: 'rules', keys: [{ id: 'long', name: 'LONG', conditions: [{ mode: 'chat', what: 'messages', op: 'gte', value: 50 }] }], fallback: { id: 'short', name: 'SHORT' } }),
            seed: n('seed', 'prompt', 0, { content: 'seed', role: 'user' }),
            sum: n('sum', 'generate', 300, { content: 'SUMMARISE' }),
            brief: n('brief', 'prompt', 300, { content: 'brief', role: 'user' }),
        },
        wires: {},
    };
    connect(g, 'seed', 'dec', 'merge'); connect(g, 'dec', 'sum', 'merge', { port: 'long' });
    connect(g, 'dec', 'brief', 'merge', { port: 'short' }); connect(g, 'sum', 'out', 'merge'); connect(g, 'brief', 'out', 'merge');
    asked.length = 0;
    const r8 = await run(g);
    assert.equal(asked.length, 0);
    assert.deepEqual(r8.plan.messages.map(m => m.content), ['seed', 'brief']);
    // and the preview knows it exactly
    const p8 = await compile(g, { dryRun: true, live });
    assert.deepEqual(p8.messages.map(m => m.content), ['seed', 'brief']);
    assert.equal(p8.stages.filter(s => !s.final).length, 0, 'preview lists no call for the untaken path');
}

// 9. nested Deciders: inner one is only consulted on the outer's chosen path
{
    const mk = (id, y, key, cond) => n(id, 'decider', y, { mode: 'rules', keys: [{ id: key, name: key, conditions: [cond] }], fallback: { id: id + '_f', name: 'no' } });
    const g = {
        nodes: {
            out: n('out', 'output', 900),
            src: n('src', 'prompt', 0, { content: 'the Elara text', role: 'user' }),
            a: mk('a', 100, 'yes', { mode: 'search', scope: 'incoming', terms: 'Elara' }),
            b: mk('b', 300, 'deep', { mode: 'search', scope: 'incoming', terms: 'text' }),
            x: n('x', 'prompt', 500, { content: 'X' }),
            y: n('y', 'prompt', 500, { content: 'Y' }),
            z: n('z', 'prompt', 500, { content: 'Z' }),
        },
        wires: {},
    };
    connect(g, 'src', 'a', 'merge'); connect(g, 'a', 'b', 'merge', { port: 'yes' }); connect(g, 'a', 'z', 'merge', { port: 'a_f' });
    connect(g, 'b', 'x', 'merge', { port: 'deep' }); connect(g, 'b', 'y', 'merge', { port: 'b_f' });
    for (const id of ['x', 'y', 'z']) connect(g, id, 'out', 'merge');
    const p9 = await compile(g, { dryRun: true, live });
    assert.deepEqual(p9.messages.map(m => m.content), ['the Elara text', 'X']);
}
console.log('decider: ok');
