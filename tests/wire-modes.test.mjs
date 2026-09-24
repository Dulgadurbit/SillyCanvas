// Wire modes: Send (the text), Activate (only switches a block on), and
// Forward result (a Decider's decision as text, or into {{result}}).
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });
const asked = [];
c.ChatCompletionService = {
    async processRequest(req) {
        const q = req.messages.map(m => m.content).join(' | ');
        asked.push(q);
        if (q.includes('WRITE')) return { choices: [{ message: { content: globalThis.draft }, finish_reason: 'stop' }] };
        return { choices: [{ message: { content: `answer to: ${q}` }, finish_reason: 'stop' }] };
    },
};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run } = await import(`../src/run.js?v=${v}`);
const { collect, tryDecide, emissionCounts } = await import(`../src/compile.js?v=${v}`);
const { connect } = await import(`../src/state.js?v=${v}`);

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
const chatWith = (text) => [{ is_user: true, mes: text, name: 'User' }];
const liveFor = (text) => ({ chat: chatWith(text), substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {}, name1: 'User', name2: 'Char' });

// Decider on the last user message: Red if "red|crimson", else Otherwise.
function colourGraph() {
    const g = {
        nodes: {
            hist: n('hist', 'history', 0, { count: 0, skip: 0 }),
            dec: n('dec', 'decider', 100, {
                mode: 'rules',
                keys: [{ id: 'kr', name: 'Red', match: 'any', conditions: [{ mode: 'search', scope: 'lastUser', terms: 'red\ncrimson' }] }],
                fallback: { id: 'kf', name: 'Otherwise' },
            }),
            redText: n('redText', 'prompt', 300, { content: 'The scene turns violent.' }),
            calm: n('calm', 'prompt', 310, { content: 'All is calm.' }),
            out: n('out', 'output', 900),
        },
        wires: {},
    };
    const w = (a, b, extra = {}) => { const r = connect(g, a, b, 'merge', extra.port ? { port: extra.port } : {}); assert.ok(r.ok, r.reason); Object.assign(r.wire, extra); return r.wire; };
    w('hist', 'out');
    w('dec', 'redText', { port: 'kr', mode: 'activate' });
    w('dec', 'calm', { port: 'kf', mode: 'activate' });
    w('redText', 'out');
    w('calm', 'out');
    return { g, w };
}
const contents = (r) => r.messages.map(m => m.content);

// ---- Activate from a Decider output ----
{
    const { g } = colourGraph();
    const live = liveFor('I paint the wall crimson.');
    const decisions = {};
    tryDecide(g, g.nodes.dec, live, {}, decisions);
    const r = collect(g, 'out', live, {}, decisions);
    assert.deepEqual(contents(r), ['I paint the wall crimson.', 'The scene turns violent.'], 'only the Red block, and no decider text carried');
    const live2 = liveFor('I sit down.');
    const d2 = {};
    tryDecide(g, g.nodes.dec, live2, {}, d2);
    assert.deepEqual(contents(collect(g, 'out', live2, {}, d2)), ['I sit down.', 'All is calm.']);
    // an Activate wire is not a text path, so no "sent twice" counting
    assert.equal(emissionCounts(g).get('dec'), 0);
}

// ---- Activate from an ordinary block, following its condition ----
{
    const g = {
        nodes: {
            night: n('night', 'prompt', 0, { content: 'ignored text', condition: { mode: 'chat', what: 'lastSpeaker', value: 'user' } }),
            x: n('x', 'prompt', 200, { content: 'X runs' }),
            out: n('out', 'output', 900),
        },
        wires: {
            a: { id: 'a', from: 'night', to: 'x', kind: 'merge', mode: 'activate' },
            b: { id: 'b', from: 'x', to: 'out', kind: 'merge' },
        },
    };
    assert.deepEqual(contents(collect(g, 'out', liveFor('hi'))), ['X runs'], 'source on -> X on, and the source text is not carried');
    g.nodes.night.enabled = false;
    const r = collect(g, 'out', liveFor('hi'));
    assert.deepEqual(contents(r), [], 'source off -> X off');
    assert.match(r.trace.find(t => t.id === 'x').why, /not activated/);
    // chains: y is switched on by x, which is switched on by night
    g.nodes.night.enabled = true;
    g.nodes.y = n('y', 'prompt', 300, { content: 'Y runs' });
    g.wires.c = { id: 'c', from: 'x', to: 'y', kind: 'merge', mode: 'activate' };
    g.wires.d = { id: 'd', from: 'y', to: 'out', kind: 'merge' };
    assert.deepEqual(contents(collect(g, 'out', liveFor('hi'))), ['X runs', 'Y runs']);
    g.nodes.night.enabled = false;
    assert.deepEqual(contents(collect(g, 'out', liveFor('hi'))), [], 'switched off all down the chain');
}

// ---- Forward result ----
{
    const { g, w } = colourGraph();
    g.nodes.mood = n('mood', 'prompt', 400, { content: 'Mood: {{result}}.' });
    w('dec', 'mood', { port: 'kr', mode: 'result' });
    w('mood', 'out');
    const live = liveFor('a red door');
    const d = {};
    tryDecide(g, g.nodes.dec, live, {}, d);
    assert.ok(contents(collect(g, 'out', live, {}, d)).includes('Mood: Red.'), '{{result}} filled with the output name');
    g.wires[Object.keys(g.wires).find(k => g.wires[k].to === 'mood')].result = 'matched';
    assert.ok(contents(collect(g, 'out', live, {}, d)).includes('Mood: red.'), 'or with the matched word');
    // without the macro, the decision is added like wired text
    g.nodes.mood.content = 'Mood is';
    g.wires[Object.keys(g.wires).find(k => g.wires[k].to === 'mood')].kind = 'append';
    assert.ok(contents(collect(g, 'out', live, {}, d)).includes('Mood is\n\nred'));
    // not chosen -> the mood block gets nothing from it
    const live2 = liveFor('nothing here'); const d2 = {};
    tryDecide(g, g.nodes.dec, live2, {}, d2);
    g.nodes.mood.content = 'Mood: {{result}}.';
    assert.ok(!contents(collect(g, 'out', live2, {}, d2)).some(t => t.includes('Red')));
}

// ---- a real send: a Generate block behind an Activate wire only runs when switched on ----
{
    const build = () => {
        const g = {
            nodes: {
                q: n('q', 'prompt', 0, { content: 'WRITE', role: 'user' }),
                draft: n('draft', 'generate', 100, { content: '' }),
                dec: n('dec', 'decider', 200, {
                    mode: 'rules',
                    keys: [{ id: 'kr', name: 'Fix', match: 'any', conditions: [{ mode: 'search', scope: 'incoming', terms: 'Elara' }] }],
                    fallback: { id: 'kf', name: 'Otherwise' },
                }),
                fixer: n('fixer', 'generate', 400, { content: 'FIX the names', role: 'user' }),
                out: n('out', 'output', 900),
            },
            wires: {},
        };
        const w = (a, b, extra = {}) => { const r = connect(g, a, b, 'merge', extra.port ? { port: extra.port } : {}); assert.ok(r.ok, r.reason); Object.assign(r.wire, extra); };
        w('q', 'draft'); w('draft', 'dec'); w('draft', 'out');
        w('dec', 'fixer', { port: 'kr', mode: 'activate' });
        w('fixer', 'out');
        return g;
    };
    globalThis.draft = 'Elara smiled.';
    asked.length = 0;
    let r = await run(build());
    assert.equal(asked.length, 2, 'draft, then the fixer once switched on');
    assert.ok(asked[1].includes('FIX the names'));
    globalThis.draft = 'She smiled.';
    asked.length = 0;
    r = await run(build());
    assert.equal(asked.length, 1, 'the fixer is never called when not switched on');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['She smiled.']);
}

console.log('wire-modes: ok');
