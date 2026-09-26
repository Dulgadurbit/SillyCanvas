// A Generate block passes on only its answer, or its answer and its inputs.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const g = S.blankGraph('F');
const out = S.outputNode(g);
const a = Object.assign(S.addNode(g, 'prompt', 0, 0), { content: 'LORE' });
const b = Object.assign(S.addNode(g, 'prompt', 0, 100), { content: 'SCENE' });
const gen = Object.assign(S.addNode(g, 'generate', 0, 300), { content: 'Plan.', title: 'Plan' });
S.connect(g, a.id, gen.id, 'merge'); S.connect(g, b.id, gen.id, 'merge'); S.connect(g, gen.id, out.id, 'merge');
const live = { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
const sent = () => C.collect(g, out.id, live, { [gen.id]: 'THE PLAN' }).messages.map(m => m.content);
assert.deepEqual(sent(), ['THE PLAN'], 'by default only the answer');
gen.forward = 'all';
assert.deepEqual(sent(), ['LORE', 'SCENE', 'THE PLAN'], 'inputs first, then the answer');
// a wire filter and a switched-off input still apply
b.enabled = false;
assert.deepEqual(sent(), ['LORE', 'THE PLAN']);
// the question the Generate block is asked is unchanged
assert.deepEqual(C.collect(g, gen.id, live).messages.map(m => m.content), ['LORE', 'Plan.']);
console.log('forward: ok');
