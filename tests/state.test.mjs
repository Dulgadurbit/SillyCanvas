// State block: values worked out from the chat (swipe-safe), rules, stage
// tables, one output per value, Activate from a value, {{state::}} macros,
// formulas in Decider rules and on wires.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const V = await import(`../src/statevals.js?v=${v}`);
const E = await import(`../src/expr.js?v=${v}`);

// ---- formulas ----
assert.equal(E.evaluate('min(10, hunger + 2)', { hunger: 9 }), 10);
assert.equal(E.holds('energy <= 2 and turn % 5 == 0', { energy: 1, turn: 10 }), true);
assert.equal(E.holds('mood == "angry"', { mood: 'Angry' }), true);
assert.equal(E.evaluate('1 +', {}, 'bad'), 'bad', 'a broken formula gives the fallback');
assert.deepEqual(E.check('energ + 1', ['energy']).unknown, ['energ']);

// ---- phrases, with negation ----
assert.equal(V.mentions('She finally sleeps.', 'sleeps, naps'), 'sleeps');
assert.equal(V.mentions('She didn’t sleep at all.', 'sleep'), null);
assert.equal(V.mentions('She didn’t sleep at all.', 'sleep', { negation: false }), 'sleep');
assert.equal(V.mentions('asleepy', 'sleep'), null, 'word starts only');

// ---- a block: energy 10, -1 per turn, back to 10 on sleep; hunger +2 every 2 turns ----
const block = {
    id: 'st', type: 'state', title: 'Needs', x: 0, y: 0, enabled: true, role: 'system',
    values: [
        {
            id: 'e', name: 'energy', kind: 'number', start: 10, min: 0, max: 10, output: 'text',
            rules: [
                { id: 'r1', when: 'turn', op: 'sub', amount: '1' },
                { id: 'r2', when: 'phrase', terms: 'sleeps, goes to bed', who: 'char', op: 'reset' },
            ],
            stages: [
                { from: 7, to: 10, name: 'rested', text: '' },
                { from: 4, to: 6, name: 'tired', text: '{{char}} is getting tired.' },
                { from: 1, to: 3, name: 'exhausted', text: '{{char}} is exhausted.' },
                { from: 0, to: 0, name: 'asleep', text: '{{char}} falls asleep.' },
            ],
        },
        { id: 'h', name: 'hunger', kind: 'number', start: 0, min: 0, max: 10, output: 'number', rules: [{ id: 'r3', when: 'every', n: 2, op: 'add', amount: '2' }], stages: [] },
        { id: 'm', name: 'mood', kind: 'text', start: 'calm', output: 'text', rules: [{ id: 'r4', when: 'formula', formula: 'energy <= 3', op: 'set', amount: 'grumpy' }], stages: [] },
    ],
};
const say = (n) => Array.from({ length: n }, (_, i) => [{ is_user: true, mes: `u${i}` }, { is_user: false, mes: `c${i}` }]).flat();
let st = V.computeState(block, say(5));
assert.deepEqual(st.byName, { energy: 5, hunger: 4, mood: 'calm' });
assert.equal(st.turn, 5);
st = V.computeState(block, say(8));
assert.deepEqual(st.byName, { energy: 2, hunger: 8, mood: 'grumpy' });
st = V.computeState(block, say(20));
assert.equal(st.byName.energy, 0, 'kept within 0..10');
assert.equal(st.byName.hunger, 10);
// relieved by the character's reply; not by a refusal, not by the user saying it
const chat = [...say(6), { is_user: true, mes: 'You should go to bed.' }, { is_user: false, mes: 'She yawns and goes to bed.' }];
assert.equal(V.computeState(block, chat).byName.energy, 10);
const refused = [...say(6), { is_user: true, mes: 'bed?' }, { is_user: false, mes: 'She refuses to go to bed.' }];
assert.equal(V.computeState(block, refused).byName.energy, 3);
// swipe-safe: the same chat always gives the same values, however often
assert.deepEqual(V.computeState(block, chat).byId, V.computeState(block, chat).byId);
// deleting the last exchange simply gives the earlier value
assert.equal(V.computeState(block, chat.slice(0, -2)).byName.energy, 4);
// a value set by hand, kept on its message
const nudged = say(3); nudged[5].extra = { [V.NUDGE_KEY]: { st: { e: 9 } } };
assert.equal(V.computeState(block, [...nudged, ...say(1)]).byName.energy, 8);
// stages and outputs
assert.equal(V.stageFor(block.values[0], 5).name, 'tired');
assert.equal(V.valueOutput(block.values[0], 9), '', 'rested sends nothing');
assert.equal(V.valueOutput(block.values[0], 2, t => t.replace('{{char}}', 'Kenzy')), 'Kenzy is exhausted.');
assert.equal(V.valueOutput(block.values[1], 4), '4');

// ---- on the canvas ----
const n = (id, type, y, extra = {}) => ({ id, type, title: id, x: 0, y, w: 260, enabled: true, role: 'system', ...extra });
const g = { id: 'g', nodes: { st: structuredClone(block), out: n('out', 'output', 900) }, wires: {} };
const w = (a, b, extra = {}) => { const r = S.connect(g, a, b, 'merge', extra.port ? { port: extra.port } : {}); assert.ok(r.ok, r.reason); Object.assign(r.wire, extra); return r.wire; };
assert.equal(S.connect(g, 'st', 'out', 'merge').ok, false, 'a State wire must come from one of its values');
w('st', 'out', { port: 'e' });
const live = (turns) => ({ chat: say(turns), substitute: t => t.replace(/\{\{char\}\}/g, 'Kenzy'), worldInfo: {}, extensionPrompts: {}, card: {}, name2: 'Kenzy' });
const sent = (L) => C.collect(g, 'out', L).messages.map(m => m.content);
assert.deepEqual(sent(live(2)), [], 'rested: nothing sent');
assert.deepEqual(sent(live(5)), ['Kenzy is getting tired.']);
assert.deepEqual(sent(live(8)), ['Kenzy is exhausted.']);
// the trace shows the values
const t = C.collect(g, 'out', live(5)).trace.find(x => x.id === 'st');
assert.match(t.why, /energy 5 \(tired\)/);
assert.deepEqual(t.decision, ['e', 'h', 'm'], 'values with something to send');
assert.ok(!C.collect(g, 'out', live(2)).trace.find(x => x.id === 'st').decision.includes('e'), 'rested energy sends nothing');

// Activate from a value: a scene block only runs while the value has something to say
g.nodes.sleep = n('sleep', 'prompt', 500, { content: 'Write her dozing off.' });
w('st', 'sleep', { port: 'e', mode: 'activate' });
w('sleep', 'out');
assert.ok(!sent(live(2)).includes('Write her dozing off.'));
assert.ok(sent(live(9)).includes('Write her dozing off.'));

// {{state::}}, {{stage::}}, {{statetext::}} in any block
g.nodes.hud = n('hud', 'prompt', 50, { content: 'Energy {{state::energy}}/10 ({{stage::energy}}), hunger {{state::Hunger}}. {{statetext::energy}}' });
w('hud', 'out');
assert.ok(sent(live(5)).includes('Energy 5/10 (tired), hunger 4. Kenzy is getting tired.'));

// a condition on a wire: only once energy is 2 or less
delete g.wires[Object.keys(g.wires).find(k => g.wires[k].from === 'hud')];
const cw = w('hud', 'out'); cw.condition = { mode: 'expr', formula: 'energy <= 2' };
assert.ok(!sent(live(5)).some(x => x.startsWith('Energy')));
assert.ok(sent(live(8)).some(x => x.startsWith('Energy 2/10')));
// a condition on a wire that looks at the text on it
cw.condition = { mode: 'search', scope: 'incoming', terms: 'exhausted' };
assert.ok(sent(live(8)).some(x => x.startsWith('Energy')));
assert.ok(!sent(live(5)).some(x => x.startsWith('Energy')));
// on an Activate wire: the sleep scene only past turn 9
const aw = Object.values(g.wires).find(x => x.to === 'sleep');
aw.condition = { mode: 'expr', formula: 'turn >= 10' };
assert.ok(!sent(live(9)).includes('Write her dozing off.'));
assert.ok(sent(live(10)).includes('Write her dozing off.'));

// a Decider routes on a formula over State values
const d = { id: 'g2', nodes: {
    st: structuredClone(block),
    dec: n('dec', 'decider', 300, { mode: 'first', keys: [{ id: 'k', name: 'Tired', match: 'any', conditions: [{ mode: 'expr', formula: 'energy <= 5' }] }], fallback: { id: 'f', name: 'Otherwise' } }),
    p: n('p', 'prompt', 500, { content: 'TIRED BRANCH' }),
    out: n('out', 'output', 900),
}, wires: {} };
const r1 = S.connect(d, 'dec', 'p', 'merge', { port: 'k' }); r1.wire.mode = 'activate';
S.connect(d, 'p', 'out', 'merge');
let dec = {}; C.tryDecide(d, d.nodes.dec, live(3), {}, dec);
assert.equal(dec.dec.name, 'Otherwise');
dec = {}; C.tryDecide(d, d.nodes.dec, live(6), {}, dec);
assert.equal(dec.dec.name, 'Tired');
assert.deepEqual(C.collect(d, 'out', live(6), {}, dec).messages.map(m => m.content), ['TIRED BRANCH']);

// wire preview of a State value
assert.deepEqual(C.wirePreview(g, Object.values(g.wires).find(x => x.from === 'st' && x.to === 'out'), live(5)), [{ role: 'system', content: 'Kenzy is getting tired.' }]);
console.log('state: ok');
