// A Generate block set to "same as the chat" follows the chat's live model,
// not the stale model saved in the selected connection profile.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
const c = installMock({ settings: { graphs: {} } });
c.mainApi = 'openai';
c.extensionSettings.connectionManager = {
    selectedProfile: 'p1',
    profiles: [{ id: 'p1', name: 'Openrouter - Personal', mode: 'cc', api: 'openrouter', model: 'openai/gpt-6-luna', exclude: [] },
               { id: 'p2', name: 'Other', mode: 'cc', api: 'openrouter', model: 'anthropic/claude-x', exclude: [] }],
};
c.chatCompletionSettings.chat_completion_source = 'openrouter';
c.getChatCompletionModel = () => 'google/gemini-3.8-flash';
const viaProfile = [], viaChat = [];
c.ConnectionManagerRequestService = { async sendRequest(pid, msgs, max, opts, override) { viaProfile.push({ pid, override }); return { choices: [{ message: { content: 'ok' } }] }; } };
c.ChatCompletionService = { async processRequest(req) { viaChat.push(req); return { choices: [{ message: { content: 'ok' } }] }; } };
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const { testBlock, effectiveModel } = await import(`../src/run.js?v=${v}`);
const g = (extra = {}) => ({ nodes: { gen: { id: 'gen', type: 'generate', title: 'G', x: 0, y: 0, enabled: true, content: 'Q', role: 'user', thinking: 'off', ...extra } }, wires: {} });

// following the chat: profile kept for its key, live model sent
await testBlock(g(), g().nodes.gen);
assert.equal(viaProfile.at(-1).pid, 'p1');
assert.equal(viaProfile.at(-1).override.model, 'google/gemini-3.8-flash');
assert.equal(effectiveModel(g().nodes.gen), 'google/gemini-3.8-flash');

// the block's own model still wins
await testBlock(g({ model: 'x/own' }), g({ model: 'x/own' }).nodes.gen);
assert.equal(viaProfile.at(-1).override.model, 'x/own');

// a block with its own profile uses that profile's saved model
await testBlock(g({ profileId: 'p2' }), g({ profileId: 'p2' }).nodes.gen);
assert.equal(viaProfile.at(-1).pid, 'p2');
assert.equal(viaProfile.at(-1).override.model, undefined, 'profile model left alone');
assert.equal(effectiveModel(g({ profileId: 'p2' }).nodes.gen), 'anthropic/claude-x');

// the chat moved to another provider entirely: the profile is skipped
c.chatCompletionSettings.chat_completion_source = 'makersuite';
c.getChatCompletionModel = () => 'gemini-3-pro';
const before = viaProfile.length;
await testBlock(g(), g().nodes.gen);
assert.equal(viaProfile.length, before, 'profile not used');
assert.equal(viaChat.at(-1).chat_completion_source, 'makersuite');
assert.equal(viaChat.at(-1).model, 'gemini-3-pro');
console.log('model-follow: ok');
