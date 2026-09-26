// Jev: yes/no rules and AI sorting through TypeSafe's decision model.
import assert from 'node:assert/strict';
const { installMock } = await import('./mock.js');
const c = installMock({ settings: {} });
c.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const J = await import(`../src/jev.js?v=${v}`);
const R = await import(`../src/run.js?v=${v}`);

// no key: a clear error
await assert.rejects(J.jevYesNo('x', 'y'), /API key/);
J.jevSettings().key = 'sk-test';

const calls = [];
let reply = null;
let corsBlocked = true, proxyOn = true;
J.setJevFetch(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.startsWith('https://') && corsBlocked) throw new TypeError('Failed to fetch');
    if (url.startsWith('/proxy/') && !proxyOn) return { ok: false, status: 404, text: async () => 'CORS proxy is disabled. Enable it in config.yaml' };
    return { ok: true, status: 200, json: async () => reply(JSON.parse(init.body)) };
});

// 1. yes/no: direct is refused (CORS), the proxy works and is remembered
reply = (b) => ({ model: 'jev-1', answers: { q: { type: 'noul', noul: 0.82 } } });
let r = await J.jevYesNo('He swings the sword.', 'Is there a fight?');
assert.equal(r.yes, true); assert.equal(r.p, 0.82);
assert.deepEqual(calls.map(x => x.url), ['https://api.typesafe.ai/v1/systemone', '/proxy/https://api.typesafe.ai/v1/systemone']);
assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-test');
assert.equal(calls[1].init.headers['X-CSRF-Token'], 't');
assert.equal(calls[1].body.questions.q.type, 'noul');
assert.equal(calls[1].body.state, 'He swings the sword.');
assert.equal(J.jevSettings().route, 'proxy');
calls.length = 0;
r = await J.jevYesNo('calm', 'Is there a fight?', { threshold: 0.9 });
assert.equal(r.yes, false, 'below the threshold is NO');
assert.equal(calls.length, 1, 'straight to the proxy the second time');

// 2. proxy switched off: says how to switch it on
delete J.jevSettings().route; proxyOn = false;
await assert.rejects(J.jevYesNo('a', 'b'), /enableCorsProxy: true/);
proxyOn = true;

// 3. sorting, several: one noul per output, in one call
calls.length = 0;
const keys = [{ id: 'a', name: 'Combat', description: 'A fight breaks out' }, { id: 'b', name: 'Romance', description: '' }, { id: 'c', name: 'Travel' }];
reply = () => ({ answers: { k0: { noul: 0.9 }, k1: { noul: 0.2 }, k2: { noul: 0.61 } } });
let s = await J.jevSort('text', keys, { several: true, threshold: 0.6 });
assert.deepEqual(s.keys, ['a', 'c']);
assert.equal(calls.at(-1).url, '/proxy/https://api.typesafe.ai/v1/systemone');
assert.equal(Object.keys(calls.at(-1).body.questions).length, 3, 'all outputs in one call');
assert.match(calls.at(-1).body.questions.k0.instructions, /A fight breaks out/);
assert.match(s.why, /Jev picked Combat, Travel/);

// 4. sorting, one pick: a choice with a "none of these" option
reply = (b) => {
    assert.ok(b.questions.pick.criteria['none of these']);
    assert.equal(b.questions.pick.criteria.Combat, 'A fight breaks out');
    return { answers: { pick: { type: 'choice', choice: 'Romance', probabilities: { Combat: 0.1, Romance: 0.7, Travel: 0.1, 'none of these': 0.1 }, confidence: 0.6 } } };
};
s = await J.jevSort('text', keys, { several: false });
assert.deepEqual(s.keys, ['b']);
reply = () => ({ answers: { pick: { choice: 'none of these', probabilities: { Combat: 0.1, Romance: 0.1, Travel: 0.1, 'none of these': 0.7 } } } });
s = await J.jevSort('text', keys, { several: false });
assert.deepEqual(s.keys, []);

// 5. a refused key reads as such
J.setJevFetch(async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}' }));
await assert.rejects(J.jevYesNo('a', 'b'), /API key was refused: bad key/);

// 6. through the Decider runner: the sorter uses Jev when told to
J.setJevFetch(async () => ({ ok: true, status: 200, json: async () => ({ answers: { k0: { noul: 0.95 }, k1: { noul: 0.05 }, k2: { noul: 0.05 } } }) }));
const dec = { id: 'd1', title: 'Router', keys, sorter: { engine: 'jev' } };
const out = await R.askSorter(dec, 'They fight.', null);
assert.deepEqual(out.keys, ['a']);
J.setJevFetch(async () => { throw new TypeError('offline'); });
delete J.jevSettings().route;
const bad = await R.askSorter(dec, 'They fight.', null);
assert.deepEqual(bad.keys, []);
assert.match(bad.why, /Jev could not be asked/);
console.log('jev: ok');
