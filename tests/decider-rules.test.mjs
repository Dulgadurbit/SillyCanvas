// Decider rule types: does-not-contain, number comparison, and the AI yes/no
// rule — asked only when it is the rule that decides, never in a preview.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });
const asked = [];
let aiSays = 'YES';
c.ChatCompletionService = {
    async processRequest(req) {
        const all = req.messages.map(m => m.content).join(' | ');
        asked.push({ all, max: req.max_tokens, last: req.messages.at(-1) });
        if (all.includes('strict classifier')) return { choices: [{ message: { content: aiSays }, finish_reason: 'stop' }] };
        return { choices: [{ message: { content: 'draft about Elara' }, finish_reason: 'stop' }] };
    },
};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run } = await import(`../src/run.js?v=${v}`);
const { compile, evaluateDecider } = await import(`../src/compile.js?v=${v}`);
const { connect } = await import(`../src/state.js?v=${v}`);
const live = { chat: [{ mes: 'a', is_user: true }, { mes: 'b' }, { mes: 'c', is_user: true }], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const ev = (cond, text = 'the cat sat on the cat mat') => evaluateDecider({ mode: 'rules', enabled: true, keys: [{ id: 'k', name: 'K', conditions: [cond] }], fallback: { id: 'f' } }, live, text).key;

// does not contain
assert.equal(ev({ mode: 'lacks', scope: 'incoming', terms: 'dog' }), 'k');
assert.equal(ev({ mode: 'lacks', scope: 'incoming', terms: 'dog\ncat' }), 'f');
// number comparisons
assert.equal(ev({ mode: 'number', source: 'words', op: 'gt', value: 5 }), 'k');
assert.equal(ev({ mode: 'number', source: 'chars', op: 'lt', value: 5 }), 'f');
assert.equal(ev({ mode: 'number', source: 'found', terms: 'cat', op: 'gte', value: 2 }), 'k', 'counts every hit');
assert.equal(ev({ mode: 'number', source: 'found', terms: 'cat', op: 'gte', value: 3 }), 'f');
assert.equal(ev({ mode: 'number', source: 'messages', op: 'eq', value: 3 }), 'k');
assert.equal(ev({ mode: 'number', source: 'turns', op: 'every', value: 2 }), 'k');
assert.equal(ev({ mode: 'number', source: 'variable', name: 'hp', op: 'lt', value: 10 }), 'f', 'unset variable never matches');
c.variables = { local: { get: (k) => (k === 'hp' ? '4' : undefined) } };
assert.equal(ev({ mode: 'number', source: 'variable', name: 'hp', op: 'lt', value: 10 }), 'k');

// AI rule, in a real run
function graph(keys) {
    const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
    const g = {
        nodes: {
            out: n('out', 'output', 900),
            q: n('q', 'prompt', 0, { content: 'WRITE', role: 'user' }),
            draft: n('draft', 'generate', 100),
            dec: n('dec', 'decider', 250, { mode: 'rules', keys, fallback: { id: 'kf', name: 'OK' } }),
            fix: n('fix', 'prompt', 450, { content: 'FIXED' }),
        },
        wires: {},
    };
    connect(g, 'q', 'draft', 'merge'); connect(g, 'draft', 'dec', 'merge');
    connect(g, 'dec', 'fix', 'merge', { port: keys[0].id }); connect(g, 'dec', 'out', 'merge', { port: 'kf' }); connect(g, 'fix', 'out', 'merge');
    return g;
}
const aiKey = [{ id: 'slop', name: 'SLOP', conditions: [{ mode: 'ai', question: 'Is this sloppy?' }] }];

asked.length = 0; aiSays = 'YES';
let r = await run(graph(aiKey));
assert.equal(asked.length, 2, 'draft + one classifier call');
assert.match(asked[1].all, /draft about Elara/, 'classifier is shown the text coming in');
assert.match(asked[1].all, /Is this sloppy\?/);
assert.equal(asked[1].last.role, 'user');
assert.deepEqual(r.plan.messages.map(m => m.content), ['draft about Elara', 'FIXED'], 'text passes down the chosen path');
assert.match(r.thoughts.find(t => t.decision).text, /AI answered YES/);

asked.length = 0; aiSays = 'No, it reads fine.';
r = await run(graph(aiKey));
assert.deepEqual(r.plan.messages.map(m => m.content), ['draft about Elara']);

asked.length = 0; aiSays = 'Hmm, hard to say';
r = await run(graph(aiKey));
assert.equal(asked.length, 3, 'draft + classifier asked twice, then treated as NO');
assert.deepEqual(r.plan.messages.map(m => m.content), ['draft about Elara']);

// a word rule that already matched means the AI is never asked
asked.length = 0; aiSays = 'YES';
r = await run(graph([
    { id: 'slop', name: 'SLOP', conditions: [{ mode: 'search', scope: 'incoming', terms: 'Elara' }, { mode: 'ai', question: 'Is this sloppy?' }] },
]));
assert.equal(asked.length, 1, 'AI skipped: the word rule decided');

// a preview never calls the classifier and says the choice is pending
asked.length = 0;
const p = await compile(graph(aiKey), { dryRun: true, live });
assert.equal(asked.length, 0);
assert.equal(p.trace.find(t => t.id === 'dec').status, 'pending');
console.log('decider-rules: ok');
