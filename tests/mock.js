// Minimal stand-in for SillyTavern.getContext(), enough to import the
// compiler under node. Pass prompts to expose them as oai_settings.prompts.
export function installMock({ prompts = [], chat = [], settings = {} } = {}) {
    const c = {
        extensionSettings: { 'prompt-canvas': settings },
        chatMetadata: {},
        chatCompletionSettings: { prompts, prompt_order: [] },
        chat,
        name1: 'User', name2: 'Char',
        maxContext: 32000,
        getCharacterCardFields: () => ({ description: 'desc', personality: '', scenario: '' }),
        getWorldInfoPrompt: async () => ({ worldInfoBefore: '', worldInfoAfter: '' }),
        extensionPrompts: {},
        getChatCompletionModel: () => 'test-model',
        substituteParams: (t) => t,
        getTokenCountAsync: async (t) => Math.ceil(t.length / 4),
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, writeExtensionField() {},
        eventSource: { on() {}, emit() {} }, eventTypes: {},
    };
    globalThis.SillyTavern = { getContext: () => c };
    return c;
}
