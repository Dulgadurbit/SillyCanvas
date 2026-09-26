// A Decider can save into a Memory block: when one of its outputs is chosen,
// what it decided is written there, for the messages after this one.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { concurrency: 2, graphs: {} } });
c.ChatCompletionService = { async processRequest() { return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }; } };
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { run } = await import(`../src/run.js?v=${v}`);
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const M = await import(`../src/memory.js?v=${v}`);
const J = await import(`../src/jev.js?v=${v}`);

const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', thinking: 'off', ...extra });
function build() {
    const g = {
        nodes: {
            out: n('out', 'output', 900),
            p: n('p', 'prompt', 0, { content: 'Write.' }),
            dec: n('dec', 'decider', 200, {
                title: 'Mood', mode: 'all',
                keys: [
                    { id: 'kf', name: 'Combat', conditions: [{ mode: 'search', scope: 'lastUser', terms: 'sword\nattack' }] },
                    { id: 'kc', name: 'Calm', conditions: [{ mode: 'search', scope: 'lastUser', terms: 'rest' }] },
                ],
                fallback: { id: 'ko', name: 'Otherwise' },
            }),
            mem: n('mem', 'memory', 400, { title: 'Log', content: '', saveMode: 'append' }),
        },
        wires: {},
    };
    S.connect(g, 'p', 'out', 'merge');
    return g;
}
// run() reads the chat from SillyTavern, so the chat is set there.
c.substituteParams = (t) => String(t).replace(/\{\{char\}\}/g, 'Mira');
const live = (msg) => { c.chat = [{ mes: msg, is_user: true, extra: {} }]; return { chat: c.chat }; };

// Wiring: only from an output; a prompt still cannot save; no duplicates.
{
    const g = build();
    assert.equal(S.connect(g, 'dec', 'mem', 'merge').ok, false, 'needs an output');
    const w = S.connect(g, 'dec', 'mem', 'merge', { port: 'kf' });
    assert.ok(w.ok, w.reason);
    assert.equal(w.wire.kind, 'save');
    assert.equal(w.wire.port, 'kf');
    assert.equal(S.connect(g, 'dec', 'mem', 'merge', { port: 'kf' }).ok, false, 'no duplicate');
    assert.ok(S.connect(g, 'dec', 'mem', 'merge', { port: 'kc' }).ok, 'another output may save too');
    assert.ok(C.reachesOutput(g).has('dec'), 'a Decider that only saves is not stranded');
}

// A run: the chosen output's name is saved; an output not chosen saves nothing.
{
    const g = build();
    S.connect(g, 'dec', 'mem', 'merge', { port: 'kf' });
    S.connect(g, 'dec', 'mem', 'merge', { port: 'kc' });
    const L = live('I draw my sword.');
    const r = await run(g);
    assert.equal(r.saves.length, 1);
    assert.equal(r.saves[0].text, 'Combat');
    assert.deepEqual(r.saves[0].from, ['Mood']);
    assert.equal(L.chat[0].extra[M.MEMORY_KEY].mem.text, 'Combat', 'kept on the message');
    assert.deepEqual(r.plan.messages.map(m => m.content), ['Write.'], 'the prompt itself is unchanged');
}

// What it saves: matched words, the text it read, your own text with macros.
{
    const g = build();
    g.nodes.q = n('q', 'prompt', 100, { content: 'The stranger attacks with a sword.' });
    S.connect(g, 'q', 'dec', 'merge');
    g.nodes.dec.keys[0].conditions[0].scope = 'incoming';
    const w = S.connect(g, 'dec', 'mem', 'merge', { port: 'kf' }).wire;
    w.save = 'matched';
    let r = (live('hi'), await run(g));
    assert.equal(r.saves[0].text, 'sword, attack');
    w.save = 'input';
    r = (live('hi'), await run(g));
    assert.equal(r.saves[0].text, 'The stranger attacks with a sword.');
    w.save = 'text'; w.saveText = '{{char}} fought ({{matched}}) after: {{input}} [{{result}}]';
    r = (live('hi'), await run(g));
    assert.equal(r.saves[0].text, 'Mira fought (sword, attack) after: The stranger attacks with a sword. [Combat]');
    // the wire's own condition still applies
    w.condition = { mode: 'chat', what: 'messages', op: 'gte', value: 5 };
    r = (live('hi'), await run(g));
    assert.equal(r.saves.length, 0);
}

// "Otherwise" can save too, and a Jev rule decides.
{
    const g = build();
    g.nodes.dec.keys[0].conditions = [{ mode: 'ai', engine: 'jev', question: 'Is there a fight?', threshold: 0.6 }];
    S.connect(g, 'dec', 'mem', 'merge', { port: 'kf' });
    S.connect(g, 'dec', 'mem', 'merge', { port: 'ko' });
    J.jevSettings().key = 'k'; J.jevSettings().route = 'proxy';
    let p = 0.9;
    J.setJevFetch(async () => ({ ok: true, status: 200, json: async () => ({ answers: { q: { type: 'noul', noul: p } } }) }));
    let r = (live('He swings.'), await run(g));
    assert.equal(r.saves[0]?.text, 'Combat', 'Jev said yes');
    p = 0.3;
    r = (live('He waves.'), await run(g));
    assert.equal(r.saves[0]?.text, 'Otherwise', 'Jev said no, so Otherwise fired and saved');
}
console.log('decider-memory: ok');
