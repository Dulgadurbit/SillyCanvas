// Memory blocks: prose the canvas remembers. Generate answers are saved into
// it (save wires), on the message the send answers, so swipes and regenerates
// save over their own earlier save and never twice. It can be mirrored into
// a lorebook entry.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const chat = [];
const ctx = installMock({ settings: { graphs: {} }, chat });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const M = await import(`../src/memory.js?v=${v}`);
const R = await import(`../src/run.js?v=${v}`);
const { applySelect } = await import(`../src/select.js?v=${v}`);

const g = S.blankGraph('T');
const out = S.outputNode(g);
const mem = S.addNode(g, 'memory', 0, 0);
mem.title = 'Cast';
mem.content = 'Mira the smith is at the forge.';
const gen = S.addNode(g, 'generate', 300, 0);
gen.title = 'Update cast';
const hist = S.addNode(g, 'history', 600, 0);

// Wiring rules: only Generate saves into memory; a save never counts as a cycle.
const p = S.addNode(g, 'prompt', 0, 400); p.content = 'P';
assert.equal(S.connect(g, p.id, mem.id, 'merge').ok, false, 'a prompt cannot save');
const read = S.connect(g, mem.id, gen.id, 'merge');           // the generator reads the cast...
assert.ok(read.ok);
const save = S.connect(g, gen.id, mem.id, 'merge');           // ...and saves the new cast
assert.ok(save.ok, save.reason);
assert.equal(save.wire.kind, 'save');
assert.equal(save.wire.loop, undefined, 'not a loop');
assert.equal(S.connect(g, gen.id, mem.id, 'merge').ok, false, 'no duplicate');
assert.ok(S.connect(g, mem.id, out.id, 'merge').ok);
assert.ok(S.connect(g, hist.id, out.id, 'merge').ok);

// The saving generator runs even though its answer does not reach Output.
assert.deepEqual(C.generateOrder(g).map(n => n.id), [gen.id]);
assert.ok(C.reachesOutput(g).has(gen.id));

const live = () => ({ chat, substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} });
const sent = () => C.collect(g, out.id, live()).messages.map(m => m.content).join('|');
const say = (u) => chat.push({ is_user: true, mes: u, extra: {} });
const reply = (c) => chat.push({ is_user: false, mes: c, extra: {} });

// No chat yet: the starting text.
assert.equal(sent(), 'Mira the smith is at the forge.');

// Turn 1: the send reads the starting text; the save lands on your message.
say('hello');
let saves = M.plannedSaves(g, { [gen.id]: 'Mira is at the market.' }, live(), { applySelect });
assert.equal(saves.length, 1);
assert.equal(saves[0].text, 'Mira is at the market.');
M.writeSaves(saves, chat);
assert.equal(chat[0].extra[M.MEMORY_KEY][mem.id].text, 'Mira is at the market.');
assert.equal(sent(), 'Mira the smith is at the forge.|hello', 'this send still reads what it held before your message');
reply('Hi!');

// A swipe of that reply answers the same message: reads the same, saves over it.
saves = M.plannedSaves(g, { [gen.id]: 'Mira is at the docks.' }, live(), { applySelect });
M.writeSaves(saves, chat);
assert.equal(chat[0].extra[M.MEMORY_KEY][mem.id].text, 'Mira is at the docks.');
assert.equal(Object.keys(chat[1].extra).length, 0, 'nothing on the reply');

// Turn 2 reads the save.
say('next');
assert.ok(sent().startsWith('Mira is at the docks.'));

// Append and keep-the-last-N.
mem.saveMode = 'append';
saves = M.plannedSaves(g, { [gen.id]: 'Tom arrives.' }, live(), { applySelect });
assert.equal(saves[0].text, 'Mira is at the docks.\n\nTom arrives.');
// regenerate: the same message again, so still ONE addition, not two
M.writeSaves(saves, chat);
saves = M.plannedSaves(g, { [gen.id]: 'Tom arrives.' }, live(), { applySelect });
M.writeSaves(saves, chat);
assert.equal(M.memoryAt(mem, chat).text, 'Mira is at the docks.\n\nTom arrives.');
reply('ok');
say('third');
mem.saveMode = 'keep'; mem.keep = 2;
saves = M.plannedSaves(g, { [gen.id]: 'Ana leaves.' }, live(), { applySelect });
assert.equal(saves[0].text, 'Tom arrives.\n\nAna leaves.');
M.writeSaves(saves, chat);

// Delete the last messages: their saves go too.
chat.splice(4);
assert.equal(M.memoryAt(mem, chat).text, 'Mira is at the docks.\n\nTom arrives.');
chat.splice(2);
assert.equal(M.memoryAt(mem, chat).text, 'Mira is at the docks.');
assert.equal(M.memoryHistory(mem, chat).length, 1);

// The save wire's filter and condition apply to what is saved.
mem.saveMode = 'replace';
save.wire.select = { between: 'cast' };
const cond = { mode: 'expr', formula: 'turn > 50' };
assert.equal(M.plannedSaves(g, { [gen.id]: 'noise <cast>ONLY THIS</cast> noise' }, live(), { applySelect })[0].text, 'ONLY THIS');
save.wire.condition = cond;
assert.equal(M.plannedSaves(g, { [gen.id]: '<cast>X</cast>' }, live(), { applySelect, wireHolds: C.wireHolds }).length, 0, 'the condition fails: nothing saved');
delete save.wire.condition; delete save.wire.select;

// No answer (failed or skipped): no save. A switched-off memory keeps nothing.
assert.equal(M.plannedSaves(g, {}, live(), { applySelect }).length, 0);
mem.enabled = false;
assert.equal(M.plannedSaves(g, { [gen.id]: 'x' }, live(), { applySelect }).length, 0);
assert.equal(C.generateOrder(g).length, 0, 'its only job was saving into a memory that is off, so it does not run');
mem.enabled = true;

// Set by hand.
M.setMemoryNow(mem, 'By hand.', chat);
assert.equal(M.memoryAt(mem, chat).text, 'By hand.');

// Lorebook mirror: made once, then updated in place.
const books = { World: { entries: {} } };
let saved = 0;
M.setWorldInfoApi({
    world_names: ['World', 'Other'],
    loadWorldInfo: async (n) => books[n],
    createWorldInfoEntry: (n, d) => { const uid = Object.keys(d.entries).length; d.entries[uid] = { uid, key: [], comment: '', content: '' }; return d.entries[uid]; },
    saveWorldInfo: async () => { saved++; },
});
assert.deepEqual(await M.lorebookNames(), ['Other', 'World']);
mem.lore = { on: true, book: 'World', title: 'The cast', keys: 'Mira, Tom', constant: false };
assert.equal((await M.mirrorToLorebook(mem, 'v1')).ok, true);
assert.equal((await M.mirrorToLorebook(mem, 'v2')).ok, true);
const entries = Object.values(books.World.entries);
assert.equal(entries.length, 1, 'updated in place, not added twice');
assert.deepEqual([entries[0].comment, entries[0].content, entries[0].key], ['The cast', 'v2', ['Mira', 'Tom']]);
assert.equal(saved, 2);
mem.lore.title = 'Cast list';                                // renamed: still the same entry
await M.mirrorToLorebook(mem, 'v3');
assert.equal(Object.values(books.World.entries).length, 1);
assert.equal(books.World.entries[0].comment, 'Cast list');
mem.lore.book = 'Nope';
assert.equal((await M.mirrorToLorebook(mem, 'v4')).ok, false);
mem.lore.book = 'World';

// A real (non-dry) run saves; a dry run (a preview, a token count) never does.
chat.length = 0; say('go');
const calls = [];
ctx.ChatCompletionService = { async processRequest(req) { calls.push(req.messages); return { choices: [{ message: { content: 'Mira sleeps.' }, finish_reason: 'stop' }] }; } };
await R.run(g, { dryRun: true });
assert.equal(calls.length, 0);
assert.equal(M.memoryAt(mem, chat).text, 'Mira the smith is at the forge.', 'a new chat starts from the starting text');
assert.equal(chat[0].extra[M.MEMORY_KEY], undefined, 'nothing saved by a dry run');
const res = await R.run(g, {});
assert.equal(calls.length, 1);
assert.ok(calls[0].some(m => m.content.includes('Mira the smith is at the forge.')), 'the generator read the memory');
assert.equal(res.saves.length, 1);
assert.deepEqual(res.saveProblems, []);
assert.equal(M.memoryAt(mem, chat).text, 'Mira sleeps.');
assert.equal(books.World.entries[0].content, 'Mira sleeps.');
assert.ok(res.plan.messages.some(m => m.content === 'Mira the smith is at the forge.'), 'this send sent what it held before');
console.log('memory: ok');
