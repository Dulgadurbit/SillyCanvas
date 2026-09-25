// Prompts as stages, both ways:
//  1. a stage sends a library prompt (live-linked), instead of its own text;
//  2. a value gives each stage its own dot: wired (Activate by default) to a
//     block, that block is on only while the value is in that stage.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const chat = [];
const turn = (u, c = 'ok') => { chat.push({ is_user: true, mes: u, extra: {} }, { is_user: false, mes: c, extra: {} }); };
const ctx = installMock({ settings: { graphs: {} }, chat });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const L = await import(`../src/library.js?v=${v}`);
const V = await import(`../src/statevals.js?v=${v}`);
const W = await import(`../src/state-window.js?v=${v}`);

const g = S.blankGraph('T');
const out = S.outputNode(g);
const st = S.addNode(g, 'state', 0, 0);
const e = S.newStateValue('energy');
e.start = 10; e.min = 0; e.max = 10;
e.rules = [{ id: 'r1', when: 'turn', op: 'sub', amount: '3' }];
W.splitStages(e, 3);                                  // 7-10, 4-6(3.67..), 0-3: whole numbers
assert.equal(e.stages.length, 3);
assert.ok(e.stages.every(s => s.id), 'every stage has an id');
assert.deepEqual(e.stages.map(s => [s.from, s.to]), [[7, 10], [4, 6], [0, 3]]);
e.stages[0].name = 'fresh'; e.stages[0].text = 'FRESH';
e.stages[1].name = 'tired';
e.stages[2].name = 'spent'; e.stages[2].text = 'SPENT';
st.values = [e];

// 1. A stage linked to a library prompt sends that prompt's current text.
const p = L.createPrompt({ name: 'tired prompt', content: 'TIRED v1' });
e.stages[1].source = 'prompt';
e.stages[1].promptId = p.id;
assert.ok(S.connect(g, st.id, out.id, 'merge', { port: e.id }).ok);

// 2. Stage dots.
e.stageDots = true;
const ports = S.outPorts(st);
assert.deepEqual(ports.map(k => k.name), ['energy', 'fresh', 'tired', 'spent']);
const spentPort = V.stagePortId(e, e.stages[2]);
const rest = S.addNode(g, 'prompt', 300, 200); rest.content = 'REST NOW'; rest.title = 'rest';
const w = S.connect(g, st.id, rest.id, 'merge', { port: spentPort });
assert.ok(w.ok);
assert.equal(w.wire.mode, 'activate', 'a stage dot wires as Activate');
assert.ok(S.connect(g, rest.id, out.id, 'merge').ok);

const send = async () => (await C.compile(g, { dryRun: true })).messages.map(m => m.content).join('|');

// Turn 0: 10, fresh. The rest prompt is off (its only Activate wire is not on).
assert.equal(await send(), 'FRESH');
turn('a');                                              // 7: still fresh
assert.equal(await send(), 'FRESH');
turn('b');                                              // 4: tired, sends the library prompt
assert.equal(await send(), 'TIRED v1');
L.updatePrompt(p.id, { content: 'TIRED v2' });
assert.equal(await send(), 'TIRED v2', 'edit the library prompt, the stage follows');
turn('c');                                              // 1: spent, and its dot switches "rest" on
assert.equal(await send(), 'SPENT|REST NOW');
// A stage dot with no text still switches its block on.
e.stages[2].text = '';
assert.equal(await send(), 'REST NOW');
// A Send wire from a stage dot carries the stage text, only in that stage.
delete w.wire.mode;
e.stages[2].text = 'SPENT';
assert.equal(await send(), 'SPENT|SPENT|REST NOW', 'in the stage: its text goes along the wire');
chat.push({ is_user: false, mes: 'x', extra: { promptCanvasState: { [st.id]: { [e.id]: 9 } } } });   // set by hand: fresh
assert.equal(await send(), 'FRESH|REST NOW', 'out of the stage: the wire carries nothing (and nothing gates rest now)');
chat.pop();
w.wire.mode = 'activate';
// Macros read linked prompts too.
const m = S.addNode(g, 'prompt', 600, 0); m.content = 'Now: {{statetext::energy}}';
chat.splice(-2, 2);                                     // back to 4: tired
S.connect(g, m.id, out.id, 'merge');
assert.ok((await send()).includes('Now: TIRED v2'));

// Turning the dots off keeps the value's own dot; the stage wires are the panel's to remove.
e.stageDots = false;
assert.deepEqual(S.outPorts(st).map(k => k.name), ['energy']);

// Old stages get ids when a canvas is loaded.
const old = { id: 'o', migrated: 2, nodes: { s: { id: 's', type: 'state', values: [{ id: 'v', stages: [{ from: 0, to: 1 }] }] } }, wires: {} };
S.migrateGraph(old);
assert.ok(old.nodes.s.values[0].stages[0].id);

// The log: every change is recorded, with the rule that made it.
const hist = V.computeState(st, chat, { timeline: true });
assert.equal(hist.timeline.length, chat.length + 1);
assert.ok(hist.log.every(x => x.ruleId === 'r1' && x.from - x.to === 3));
console.log('stage-prompts: ok');
