// Lorebook block: reads lorebooks directly, picks entries (as SillyTavern
// would, by scanning wired text, all, constant, picked), filters, limits,
// keeps them out of World Info, and tells a Decider which entries fired.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const chat = [
    { is_user: true, mes: 'We walk into the tavern.', name: 'User' },
    { is_user: false, mes: 'The innkeeper polishes a glass.', name: 'Char' },
    { is_user: true, mes: 'I draw my sword.', name: 'User' },
];
const c = installMock({ settings: { graphs: {} }, chat });
const E = (uid, comment, key, content, extra = {}) => ({ uid, comment, key, content, order: 100, position: 0, ...extra });
const books = {
    'World': { entries: {
        0: E(0, 'Tavern', ['tavern', 'inn'], 'The Rusty Mug is a tavern.'),
        1: E(1, 'Sword', ['sword'], 'Swords are forbidden in town.', { order: 200 }),
        2: E(2, 'Magic', ['/spell|magic/i'], 'Magic is rare.'),
        3: E(3, 'Rules', [], 'The town has a curfew.', { constant: true, order: 50 }),
        4: E(4, 'Dragon', ['dragon'], 'Dragons sleep in the north.', { selective: true, keysecondary: ['north'], selectiveLogic: 3 }),
        5: E(5, 'Hidden', ['tavern'], 'secret', { disable: true }),
        6: E(6, 'Cat', ['cat'], 'A cat lives here.', { matchWholeWords: true, group: 'animals' }),
    } },
    'Hero': { entries: { 0: E(0, 'Hero', ['hero'], 'The hero is tired.', { position: 4 }) } },
    'LTM': { entries: {
        0: E(0, 'Scene 1', [], 'They met.', { stmemorybooks: true, STMB_start: 0, STMB_end: 0 }),
        1: E(1, 'Scene 2', [], 'They fought.', { stmemorybooks: true, STMB_start: 1, STMB_end: 2 }),
    } },
};
c.chatMetadata = { world_info: 'World' };
c.characters = [{ avatar: 'hero.png', data: { extensions: { world: 'Hero' } } }];
c.characterId = 0;
c.loadWorldInfo = async (name) => structuredClone(books[name] ?? null);
c.getWorldInfoNames = () => Object.keys(books);
// World Info as SillyTavern would put it in, with the constant entry and Tavern in it
c.getWorldInfoPrompt = async () => ({ worldInfoBefore: 'The Rusty Mug is a tavern.\nThe town has a curfew.\nOther lore.', worldInfoAfter: '' });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const S = await import(`../src/state.js?v=${v}`);
const C = await import(`../src/compile.js?v=${v}`);
const L = await import(`../src/lore.js?v=${v}`);

// ---- key matching ----
const e = (x) => L.toEntry(x, 'b');
assert.equal(L.matchEntry(e(E(0, '', ['Tavern'], 'x')), 'the tavern').hit, true, 'case-insensitive by default');
assert.equal(L.matchEntry(e(E(0, '', ['Tavern'], 'x', { caseSensitive: true })), 'the tavern').hit, false);
assert.equal(L.matchEntry(e(E(0, '', ['cat'], 'x', { matchWholeWords: true })), 'concatenate').hit, false);
assert.equal(L.matchEntry(e(E(0, '', ['cat'], 'x', { matchWholeWords: true })), 'a cat.').hit, true);
assert.equal(L.matchEntry(e(E(0, '', ['/dr[a-z]+n/'], 'x')), 'a dragon').hit, true, 'regex keys');
const dragon = e(books.World.entries[4]);
assert.equal(L.matchEntry(dragon, 'a dragon').hit, false, 'AND ALL secondary missing');
assert.equal(L.matchEntry(dragon, 'a dragon in the north').hit, true);

// ---- a canvas with a Lorebook block ----
const g = S.createGraph('Lore');
const out = S.outputNode(g);
const lb = S.addNode(g, S.NODE_TYPES.LOREBOOK, 0, 300);
S.connect(g, lb.id, out.id, S.WIRE_KINDS.MERGE);
let live = await C.gatherContext({ dryRun: true });
assert.deepEqual(live.lore.sources.chat, ['World']);
assert.deepEqual(live.lore.sources.character, ['Hero']);
assert.equal(live.lore.books.World.length, 7);
const send = () => C.collect(g, out.id, live);
const titles = (r) => r.trace.find(t => t.id === lb.id)?.lore?.map(x => x.title);

// as SillyTavern would, estimated in a preview: constant + keys in the last 2 messages
lb.titles = true;
let r = send();
assert.deepEqual(titles(r), ['Rules', 'Tavern', 'Sword'], 'constant + keys in the last 2 messages ("inn" is in "innkeeper": not whole words by default)');
assert.match(r.trace.find(t => t.id === lb.id).why, /estimated/);
assert.equal(r.messages[0].content, 'Rules\nThe town has a curfew.\n\nTavern\nThe Rusty Mug is a tavern.\n\nSword\nSwords are forbidden in town.');

// every entry, disabled left out; include disabled
lb.mode = 'all'; lb.titles = false;
assert.equal(titles(send()).length, 7, '6 from World (one disabled) + Hero');
lb.includeDisabled = true;
assert.equal(titles(send()).length, 8);
lb.includeDisabled = false;
// constant only; picked
lb.mode = 'constant';
assert.deepEqual(titles(send()), ['Rules']);
lb.mode = 'picked'; lb.picked = ['World|2', 'Hero|0'];
assert.deepEqual(titles(send()).sort(), ['Hero', 'Magic']);
// filters: title, group, position
lb.mode = 'all';
lb.titleFilter = 'sword, tav';
assert.deepEqual(titles(send()).sort(), ['Sword', 'Tavern']);
lb.titleFilter = ''; lb.group = 'animals';
assert.deepEqual(titles(send()), ['Cat']);
lb.group = ''; lb.position = '4';
assert.deepEqual(titles(send()), ['Hero']);
lb.position = 'any';
// sources off
lb.sources = { chat: true, character: false };
assert.ok(!titles(send()).includes('Hero'));
// limits: keep the highest order
lb.maxEntries = 1;
assert.deepEqual(titles(send()), ['Sword'], 'order 200 is kept');
lb.maxEntries = 0; lb.tokenBudget = 8;
assert.ok(titles(send()).every(t => ['Sword', 'Cat', 'Magic', 'Tavern', 'Rules', 'Dragon'].includes(t)));
assert.ok(C.textOf(send().messages).length / 4 <= 8 + 2);
lb.tokenBudget = 0;
// separate + prefix + role
lb.mode = 'constant'; lb.separate = true; lb.prefix = 'Lore:'; lb.role = 'user';
assert.deepEqual(send().messages, [{ role: 'user', content: 'Lore:\n\nThe town has a curfew.' }]);
lb.separate = false; lb.prefix = ''; lb.role = 'system';

// ---- scan the text wired in; the wired text stops at the block ----
lb.mode = 'scan'; lb.includeConstant = false;
const plan = S.addNode(g, S.NODE_TYPES.PROMPT, 0, 0);
plan.content = 'Next: a dragon attacks from the north, and someone casts a spell.';
S.connect(g, plan.id, lb.id, S.WIRE_KINDS.MERGE);
r = send();
assert.deepEqual(titles(r).sort(), ['Dragon', 'Magic']);
assert.ok(!r.messages.some(m => m.content.includes('Next: a dragon')), 'the scanned text is not sent on');
assert.equal(C.emissionCounts(g).get(plan.id) ?? 0, 0);
// most recently mentioned last
lb.order = 'recent';
assert.deepEqual(titles(send()), ['Dragon', 'Magic']);
lb.order = 'order';
// scan the chat instead
lb.scanFrom = 'chat'; lb.scanDepth = 3;
assert.deepEqual(titles(send()).sort(), ['Sword', 'Tavern']);

// ---- Memory Books entries only, skipping recent scenes ----
lb.mode = 'all'; lb.sources = {}; lb.books = ['LTM']; lb.memoryOnly = true;
live = await C.gatherContext({ dryRun: true });
assert.deepEqual(titles(send()), ['Scene 1', 'Scene 2']);
lb.skipRecent = 2;   // 3 messages: skip scenes ending at #1 or later
assert.deepEqual(titles(send()), ['Scene 1']);
lb.memoryOnly = false; lb.skipRecent = 0; lb.books = []; lb.sources = { chat: true };

// ---- keep them out of World Info ----
const inj = S.addNode(g, S.NODE_TYPES.INJECTION, 0, 100); inj.sources = ['worldInfoBefore'];
S.connect(g, inj.id, out.id, S.WIRE_KINDS.MERGE);
lb.mode = 'constant';
live = await C.gatherContext({ dryRun: true });
r = send();
assert.ok(r.messages.some(m => m.content.includes('The Rusty Mug')), 'World Info as usual');
lb.excludeFromWI = true;
r = send();
const wi = r.messages.find(m => m.content.includes('Other lore'));
assert.equal(wi.content, 'Other lore.', 'the World lorebook’s entries are taken out');
assert.equal(r.messages.filter(m => m.content.includes('curfew')).length, 1, 'curfew sent once, by the block');
lb.excludeFromWI = false;
S.removeNode(g, inj.id);

// ---- Forward result: a Decider routes on which entries fired ----
lb.mode = 'scan'; lb.scanFrom = 'inputs';
const dec = S.addNode(g, S.NODE_TYPES.DECIDER, 0, 500);
dec.mode = 'all';
dec.keys = [{ id: 'kd', name: 'Danger', match: 'any', conditions: [{ mode: 'search', scope: 'incoming', terms: 'Dragon' }] }];
const res = S.connect(g, lb.id, dec.id, S.WIRE_KINDS.MERGE); res.wire.mode = 'result';
const fight = S.addNode(g, S.NODE_TYPES.PROMPT, 0, 700); fight.content = 'Write a fight scene.';
const act = S.connect(g, dec.id, fight.id, S.WIRE_KINDS.MERGE, { port: 'kd' }); act.wire.mode = 'activate';
S.connect(g, fight.id, out.id, S.WIRE_KINDS.MERGE);
assert.deepEqual(C.wirePreview(g, res.wire, live), [{ role: 'system', content: 'Dragon, Magic' }]);
let d = {};
C.tryDecide(g, dec, live, {}, d);
assert.deepEqual(d[dec.id].keys, ['kd']);
assert.ok(C.collect(g, out.id, live, {}, d).messages.some(m => m.content === 'Write a fight scene.'));
plan.content = 'A quiet morning.';
d = {};
C.tryDecide(g, dec, live, {}, d);
assert.equal(d[dec.id].name, 'Otherwise');
assert.ok(!C.collect(g, out.id, live, {}, d).messages.some(m => m.content === 'Write a fight scene.'));

// ---- a real send uses what SillyTavern activated ----
const handlers = {};
c.eventTypes = { WORLD_INFO_ACTIVATED: 'wia' };
c.eventSource = { on(t, f) { (handlers[t] ??= []).push(f); }, emit() {} };
c.getWorldInfoPrompt = async (_c, _m, dry) => {
    if (!dry) for (const f of handlers.wia ?? []) f([{ world: 'World', uid: 0 }, { world: 'World', uid: 6 }]);
    return { worldInfoBefore: '', worldInfoAfter: '' };
};
S.removeNode(g, plan.id);
lb.mode = 'st';
await C.gatherContext({ dryRun: true });           // registers the listener
live = await C.gatherContext({ dryRun: false });
assert.deepEqual(live.lore.activated, [{ world: 'World', uid: 0 }, { world: 'World', uid: 6 }]);
r = C.collect(g, out.id, live);
assert.deepEqual(titles(r).sort(), ['Cat', 'Tavern']);
assert.doesNotMatch(r.trace.find(t => t.id === lb.id).why, /estimated/);
console.log('lore: ok');
