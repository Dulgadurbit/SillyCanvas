// The redone Decider: several outputs can fire, a routing mode you choose,
// a new one does nothing until set up, rules can read one input, NOT, and
// the AI sorter.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });
const asked = [];
c.ChatCompletionService = {
    async processRequest(req) {
        const q = req.messages.map(m => m.content).join(' | ');
        asked.push(q);
        if (q.includes('CATEGORIES')) return { choices: [{ message: { content: globalThis.sorterSays ?? 'NONE' }, finish_reason: 'stop' }] };
        if (q.includes('WRITE')) return { choices: [{ message: { content: globalThis.draft }, finish_reason: 'stop' }] };
        return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    },
};
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run } = await import(`../src/run.js?v=${v}`);
const { collect, tryDecide, evaluateDecider, explainDecider, compile } = await import(`../src/compile.js?v=${v}`);
const { connect, defaultNode, NODE_TYPES } = await import(`../src/state.js?v=${v}`);

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
const live = (text) => ({ chat: [{ is_user: true, mes: text, name: 'User' }], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {}, name1: 'User', name2: 'Char' });
const words = (id, name, terms, extra = {}) => ({ id, name, match: 'any', conditions: [{ mode: 'search', scope: 'incoming', terms }], ...extra });

function router(mode) {
    const g = {
        nodes: {
            hist: n('hist', 'history', 0, { count: 0, skip: 0 }),
            dec: n('dec', 'decider', 100, { mode, keys: [words('kr', 'Red', 'red\ncrimson'), words('kb', 'Blue', 'blue\nnavy')], fallback: { id: 'kf', name: 'Otherwise' } }),
            red: n('red', 'prompt', 300, { content: 'RED' }),
            blue: n('blue', 'prompt', 310, { content: 'BLUE' }),
            none: n('none', 'prompt', 320, { content: 'NONE' }),
            out: n('out', 'output', 900),
        },
        wires: {},
    };
    const w = (a, b, extra = {}) => { const r = connect(g, a, b, 'merge', extra.port ? { port: extra.port } : {}); assert.ok(r.ok, r.reason); Object.assign(r.wire, extra); return r.wire; };
    w('hist', 'dec');
    w('dec', 'red', { port: 'kr', mode: 'activate' });
    w('dec', 'blue', { port: 'kb', mode: 'activate' });
    w('dec', 'none', { port: 'kf', mode: 'activate' });
    w('red', 'out'); w('blue', 'out'); w('none', 'out');
    return g;
}
const route = (g, text) => {
    const L = live(text); const d = {};
    tryDecide(g, g.nodes.dec, L, {}, d);
    return { d: d.dec, sent: collect(g, 'out', L, {}, d).messages.map(m => m.content) };
};

// every match: both fire
{
    const g = router('all');
    let r = route(g, 'a crimson sky over a navy sea');
    assert.deepEqual(r.d.keys, ['kr', 'kb']);
    assert.equal(r.d.name, 'Red + Blue');
    assert.deepEqual(r.sent, ['RED', 'BLUE']);
    r = route(g, 'just red');
    assert.deepEqual(r.sent, ['RED']);
    r = route(g, 'green');
    assert.deepEqual(r.sent, ['NONE'], 'Otherwise when nothing else fires');
}
// first match: only the first
{
    const r = route(router('first'), 'a crimson sky over a navy sea');
    assert.deepEqual(r.sent, ['RED']);
    // old canvases saved 'rules'
    assert.deepEqual(route(router('rules'), 'navy and red').sent, ['RED']);
}
// not set up: nothing below it is sent, and a warning says so
{
    const g = router(null);
    const r = route(g, 'red blue');
    assert.deepEqual(r.sent, []);
    assert.ok(r.d.unset);
    const plan = await compile(g, { dryRun: true, live: live('red') });
    assert.ok(plan.warnings.some(w => /not set up yet/.test(w)));
    assert.equal(defaultNode(NODE_TYPES.DECIDER, 0, 0).mode, null, 'a new Decider starts unset');
}
// NOT
{
    const g = router('all');
    g.nodes.dec.keys[1].conditions[0].not = true;   // Blue fires when there is NO blue
    assert.deepEqual(route(g, 'red').sent, ['RED', 'BLUE']);
    assert.deepEqual(route(g, 'red and blue').sent, ['RED']);
}
// a rule that reads one input only
{
    const g = router('all');
    g.nodes.story = n('story', 'prompt', 50, { content: 'The blue ocean.' });
    const r = connect(g, 'story', 'dec', 'merge'); assert.ok(r.ok);
    const histWire = Object.values(g.wires).find(w => w.from === 'hist' && w.to === 'dec');
    assert.deepEqual(route(g, 'hello').sent, ['BLUE'], 'all inputs: sees the story');
    g.nodes.dec.keys[1].conditions[0].input = histWire.id;
    assert.deepEqual(route(g, 'hello').sent, ['NONE'], 'only the chat input: no blue there');
}
// explain (the test box)
{
    const rows = explainDecider(router('all').nodes.dec, live(''), 'crimson and navy');
    assert.deepEqual(rows.map(r => [r.name, r.pass]), [['Red', true], ['Blue', true], ['Otherwise', false]]);
    const first = explainDecider(router('first').nodes.dec, live(''), 'crimson and navy');
    assert.equal(first[1].pass, false);
    assert.match(first[1].why, /already matched/);
}
// Forward result with several outputs
{
    const g = router('all');
    g.nodes.mood = n('mood', 'prompt', 400, { content: 'Colours: {{result}}.' });
    const a = connect(g, 'dec', 'mood', 'merge', { port: 'kr' }); a.wire.mode = 'result';
    connect(g, 'mood', 'out', 'merge');
    assert.ok(route(g, 'red and navy').sent.includes('Colours: Red, Blue.'));
    a.wire.result = 'matched';
    assert.ok(route(g, 'red and navy').sent.includes('Colours: red, navy.'));
}
// AI sorts: one call picks the outputs
{
    const build = () => {
        const g = router('ai');
        g.nodes.dec.keys[0].description = 'warm, angry, violent';
        g.nodes.dec.keys[1].description = 'calm, sad';
        return g;
    };
    globalThis.sorterSays = 'Blue';
    asked.length = 0;
    let r = await run(build(), { live: live('She sighs and looks at the sea.') });
    assert.equal(asked.filter(q => q.includes('CATEGORIES')).length, 1, 'one sorter call');
    assert.ok(asked[0].includes('calm, sad'), 'descriptions are sent');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['BLUE']);
    globalThis.sorterSays = 'Red, Blue';
    r = await run(build(), { live: live('x') });
    assert.deepEqual(r.plan.messages.map(m => m.content), ['RED', 'BLUE']);
    globalThis.sorterSays = 'NONE';
    r = await run(build(), { live: live('x') });
    assert.deepEqual(r.plan.messages.map(m => m.content), ['NONE']);
    const g = build(); g.nodes.dec.sorter = { several: false };
    globalThis.sorterSays = 'Red, Blue';
    r = await run(g, { live: live('x') });
    assert.deepEqual(r.plan.messages.map(m => m.content), ['RED'], 'only one when several is off');
}
console.log('decider-redo: ok');
