/**
 * Silly Canvas — the executor.
 *
 * Walks the Generate blocks in canvas order, asks the model each one's
 * question, and feeds each answer into whatever sits below it. The final
 * prompt is compiled last, with every answer in place, and handed to
 * SillyTavern as the real send.
 *
 * Rules this file will not bend:
 *
 *  - A dry run never calls a model. SillyTavern fires dry runs to count
 *    tokens; paying for those would be outrageous.
 *  - A Generate block with nothing wired into it is skipped, not asked an
 *    empty question.
 *  - A failed call does not take the whole send down. The block's answer is
 *    recorded as the error, the run continues, and you see it in the trace.
 */

import { ctx, safe, settings, save as saveSettings, NODE_TYPES, togetherGroup, loopWires, loopSection, activeGraph } from './state.js?v=0.13.0';
import { compile, collect, generateOrder, generateLevels, gatherContext, evaluateCondition, liveNodes, generateDeps, textOf, picks } from './compile.js?v=0.13.0';

/** The connection the chat itself is using, when a block does not name one. */
function currentProfileId() {
    return safe(() => ctx().extensionSettings?.connectionManager?.selectedProfile) ?? null;
}

function profileList() {
    return safe(() => ctx().extensionSettings?.connectionManager?.profiles) ?? [];
}

export function profileName(profileId) {
    return profileList().find(p => p.id === profileId)?.name ?? null;
}

export function getProfile(profileId) {
    return profileList().find(p => p.id === profileId) ?? null;
}

/**
 * The models SillyTavern already knows about for a given source.
 *
 * It keeps one <select> per provider, populated when you connect, so reading
 * those is how a Generate block can offer real models instead of asking you to
 * type an id from memory. Nothing is fetched; this is what the app already has.
 *
 * @returns {Array<{id: string, label: string, group: string|null}>}
 */
export function modelsForSource(source) {
    const ids = {
        openai: 'model_openai_select', openrouter: 'model_openrouter_select',
        claude: 'model_claude_select', makersuite: 'model_google_select',
        google: 'model_google_select', vertexai: 'model_vertexai_select',
        mistralai: 'model_mistralai_select', groq: 'model_groq_select',
        cohere: 'model_cohere_select', deepseek: 'model_deepseek_select',
        xai: 'model_xai_select', custom: 'model_custom_select',
        perplexity: 'model_perplexity_select', nanogpt: 'model_nanogpt_select',
        electronhub: 'model_electronhub_select', chutes: 'model_chutes_select',
        aimlapi: 'model_aimlapi_select', moonshot: 'model_moonshot_select',
        fireworks: 'model_fireworks_select', cometapi: 'model_cometapi_select',
        zai: 'model_zai_select', pollinations: 'model_pollinations_select',
        siliconflow: 'model_siliconflow_select', minimax: 'model_minimax_select',
        'workers-ai': 'model_workers_ai_select', togetherai: 'model_togetherai_select',
        infermaticai: 'model_infermaticai_select', dreamgen: 'model_dreamgen_select',
    };
    const el = document.getElementById(ids[source] ?? '');
    if (!el) return [];

    const out = [];
    for (const opt of el.querySelectorAll('option')) {
        const id = opt.value;
        if (!id) continue;
        out.push({
            id,
            label: (opt.textContent || id).trim(),
            group: opt.parentElement?.tagName === 'OPTGROUP' ? opt.parentElement.label : null,
        });
    }
    return out;
}

/**
 * Models we have fetched before, kept per provider so the list survives a
 * reload. SillyTavern only fills its own <select> when you connect through the
 * main UI, which you may never do if you work through connection profiles.
 */
function modelCache() {
    const s = settings();
    s.modelCache ??= {};
    return s.modelCache;
}

export function cachedModels(source) {
    return source ? (modelCache()[source] ?? []) : [];
}

/**
 * Ask SillyTavern's backend for the provider's model list, the same way its
 * own connection check does. Only ever called when you press the button: it
 * reaches the provider, so it is not something to do behind your back.
 */
export async function fetchModelList(node) {
    const c = ctx();
    const profile = getProfile(node?.profileId || currentProfileId());
    const source = sourceForBlock(node);
    if (!source) throw new Error('No provider to ask \u2014 pick a connection first.');

    const proxies = safe(() => c.extensionSettings?.connectionManager?.proxies) ?? [];
    const proxy = proxies.find?.(p => p.name === profile?.proxy) ?? null;

    const body = {
        chat_completion_source: source,
        ...(profile?.['secret-id'] ? { secret_id: profile['secret-id'] } : {}),
        ...(profile?.['api-url'] ? { custom_url: profile['api-url'], vertexai_region: profile['api-url'] } : {}),
        ...(proxy?.url ? { reverse_proxy: proxy.url, proxy_password: proxy.password } : {}),
    };

    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const json = await res.json();
    if (json?.error) throw new Error(describeError(json.error));

    const list = Array.isArray(json?.data) ? json.data : [];
    const models = list
        .map(m => (typeof m === 'string'
            ? { id: m, label: m, group: null }
            : { id: m.id ?? m.model ?? '', label: m.name ?? m.id ?? m.model ?? '', group: null }))
        .filter(m => m.id);

    if (models.length) {
        modelCache()[source] = models;
        safe(() => c.saveSettingsDebounced());
    }
    return models;
}

/** The API a connection profile talks to, in chat completion source terms. */
function profileSource(profile) {
    if (!profile?.api) return null;
    const api = String(profile.api).replace(/-text$/, '');
    return api === 'openai' ? 'openai' : api;
}

/**
 * For a block that follows the chat: the chat's live model, and whether the
 * selected profile still points at the same provider (so its key, endpoint
 * and preset still apply).
 */
export function followChat(node) {
    const c = ctx();
    if (node?.profileId) return { following: false, useProfile: true, model: null };
    const main = safe(() => c.mainApi) ?? 'openai';
    const profile = getProfile(currentProfileId());
    if (main !== 'openai') return { following: true, useProfile: true, model: null };
    const live = safe(() => c.chatCompletionSettings?.chat_completion_source) ?? null;
    const model = safe(() => c.getChatCompletionModel()) || null;
    const same = !!profile && profile.mode === 'cc' && (!live || profileSource(profile) === live);
    return { following: true, useProfile: same, model, source: live };
}

/** The model a Generate block will actually be sent to. */
export function effectiveModel(node) {
    if (node?.model) return node.model;
    const f = followChat(node);
    if (f.following && f.model) return f.model;
    return inspectProfile(node?.profileId || currentProfileId()).model || null;
}

/** The provider a Generate block will actually go through. */
export function sourceForBlock(node) {
    const f = followChat(node);
    if (f.following && f.source && !f.useProfile) return f.source;
    const profile = getProfile(node?.profileId || currentProfileId());
    if (profile?.api) {
        // Connection profiles name the API; chat completion sources match it.
        const api = String(profile.api).replace(/-text$/, '');
        return api === 'openai' ? (safe(() => ctx().chatCompletionSettings?.chat_completion_source) ?? 'openai') : api;
    }
    return safe(() => ctx().chatCompletionSettings?.chat_completion_source) ?? null;
}

/**
 * What a connection profile is missing, if anything.
 *
 * A profile can legitimately leave the model unset (SillyTavern's "exclude"
 * list) so that it follows whatever the chat is using. That is fine for a
 * normal send, where SillyTavern fills the model in — but a Generate block
 * goes out through the profile directly, and a chat completion request with
 * no model at all is rejected with a bare "Bad Request". So the gap has to be
 * filled here rather than discovered at the provider.
 *
 * @returns {{model: string|null, fills: string[], problems: string[]}}
 */
export function inspectProfile(profileId) {
    const c = ctx();
    const profile = getProfile(profileId);
    const fills = [];
    const problems = [];

    if (!profile) return { model: null, fills, problems: profileId ? ['That connection profile no longer exists.'] : [] };

    let model = profile.model ?? null;

    if (profile.mode === 'cc' && !model) {
        model = safe(() => c.getChatCompletionModel()) ?? null;
        if (model) fills.push(`"${profile.name}" saves no model, so this uses the chat's current one (${model}).`);
        else problems.push(`"${profile.name}" saves no model and SillyTavern has none selected, so there is nothing to send to.`);
    }

    if (profile.preset) {
        const found = safe(() => c.getPresetManager(profile.mode === 'tc' ? 'textgenerationwebui' : 'openai')
            ?.getCompletionPresetByName(profile.preset));
        if (!found) {
            problems.push(`"${profile.name}" points at a preset named "${profile.preset}" that SillyTavern cannot find, so none of its sampler settings are applied.`);
        }
    }

    return { model, fills, problems };
}

/**
 * SillyTavern wraps request failures as `new Error('API request failed',
 * { cause })`, so the message alone tells you nothing. Walk the chain and
 * report what actually went wrong.
 */
export function describeError(err) {
    const parts = [];
    let cur = err;
    let depth = 0;
    while (cur && depth++ < 6) {
        const text = typeof cur === 'string' ? cur : (cur.message ?? String(cur));
        if (text && !parts.includes(text)) parts.push(text);
        if (cur.status) parts.push(`HTTP ${cur.status}`);
        cur = cur.cause;
    }
    const seen = parts.filter(p => p && p !== 'API request failed');
    return (seen.length ? seen : parts).join(' \u2014 ') || 'unknown error';
}

/** Failures worth trying again: rate limits, gateway hiccups, timeouts. */
function looksTransient(message) {
    return /\b(429|408|425|500|502|503|504)\b|rate.?limit|too many requests|timed? ?out|overload|temporarily|ECONNRESET|socket hang up|fetch failed/i
        .test(String(message));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * How much of its budget a model may spend thinking before it answers.
 *
 * Providers spell this differently and some ignore it, so this maps to what
 * each one understands. OpenRouter takes "none", which is the one that matters
 * here: without it a reasoning model can burn the whole budget thinking and
 * get cut off mid-answer.
 */
function reasoningEffortFor(level, source) {
    if (!level || level === 'inherit') return undefined;
    if (level === 'off') {
        // "none" reads like the obvious answer and is what SillyTavern sends
        // for its own minimum, but Gemini through OpenRouter rejects it with a
        // bare Bad Request. "minimal" is accepted and measurably does the job:
        // zero thinking tokens, whole answer, finish_reason "stop".
        if (source === 'openai' || source === 'azure_openai' || source === 'openrouter') return 'minimal';
        return 'low';
    }
    return level;   // low | medium | high
}

function extractText(res) {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object') {
        if (typeof res.content === 'string') return res.content;
        if (typeof res.text === 'string') return res.text;
    }
    return '';
}

/**
 * Make a message list a provider will actually accept.
 *
 * This is the bug that made Generate blocks fail. A thinking pass is naturally
 * all system messages — a system prompt block, a system-role history block, the
 * Generate block's own system text — and SillyTavern's "merge" post-processing
 * squashes those into ONE system message with no user turn at all. OpenRouter,
 * Gemini and Claude all reject that outright: there has to be something for the
 * model to answer.
 *
 * So: if nothing in the list is a user or assistant turn, the last message
 * becomes the user turn. Its text is untouched; only the label changes, which
 * is exactly how you would have written it by hand.
 *
 * @returns {{messages: Array, note: string|null}}
 */
export function shapeForApi(messages, node = null) {
    const out = messages
        .filter(m => m && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ ...m }));

    if (!out.length) return { messages: out, note: null };

    const hasTurn = out.some(m => m.role === 'user' || m.role === 'assistant');
    if (hasTurn) {
        // A Generate block's task usually comes last, as a system message,
        // after the chat. Most providers lift every system message to the
        // top, so the last thing the model actually sees is the chat's final
        // turn — and it answers the roleplay instead of doing the task.
        // Sending the task as the closing user turn keeps it the question.
        const last = out[out.length - 1];
        if (node && node.instructionAsUser !== false && last.role === 'system') {
            last.role = 'user';
            return { messages: out, note: 'the closing instruction was sent as the user turn, so the model answers it rather than the chat' };
        }
        return { messages: out, note: null };
    }

    out[out.length - 1].role = 'user';
    return {
        messages: out,
        note: 'every block here was a system message, so the last one was sent as the user turn — providers reject a prompt with nothing to answer',
    };
}

/**
 * Ask one model one question.
 * @param {Array} messages
 * @param {object} node the Generate block
 * @param {AbortSignal|null} signal
 */
async function askModel(rawMessages, node, signal = null) {
    const { messages, note } = shapeForApi(rawMessages, node);
    if (note) console.log(`[prompt-canvas] "${node.title}": ${note}`);
    if (!messages.length) throw new Error('nothing to send');

    const c = ctx();
    const maxTokens = Math.max(1, Number(node.maxTokens) || DEFAULT_MAX_TOKENS);
    // "Same as the chat" means what the chat is using right now. The selected
    // connection profile is kept for its key, endpoint and preset, but its
    // saved model can be stale: switch the chat to another model without
    // re-saving the profile and the blocks would stay on the old one. So when
    // a block follows the chat, the chat's live model wins — and if the chat
    // has moved to a different provider altogether, the profile is skipped.
    const follow = followChat(node);
    const profileId = node.profileId || (follow.useProfile ? currentProfileId() : null);

    // A connection profile carries its own API, key, preset and prompt
    // post-processing, so routing through one is what makes "send this block
    // with a different model" work without hand-rolling each provider's syntax.
    const source = sourceForBlock(node);
    const effort = reasoningEffortFor(node.thinking ?? 'off', source);
    const thinkingPayload = effort
        ? { reasoning_effort: effort, include_reasoning: false }
        : {};

    if (profileId && c.ConnectionManagerRequestService) {
        const info = inspectProfile(profileId);
        for (const p of info.problems) console.warn(`[prompt-canvas] ${p}`);
        for (const f of info.fills) console.log(`[prompt-canvas] ${f}`);

        const profile = getProfile(profileId);
        if (profile?.mode === 'cc' && !profile.model && !info.model && !node.model) {
            throw new Error(`The connection profile "${profile.name}" has no model, and SillyTavern has none selected. Pick a model in that profile, or choose a different one for this block.`);
        }

        // The block's own choice wins; otherwise fill in only what the profile
        // leaves out, and let everything it does set stand.
        const override = { ...thinkingPayload };
        if (node.model) override.model = node.model;
        else if (!node.profileId && follow.model && profile?.mode === 'cc') override.model = follow.model;
        else if (profile?.mode === 'cc' && !profile.model && info.model) override.model = info.model;

        // extractData: false hands back the provider's whole reply, which is
        // the only way to see the token usage and why generation stopped.
        const send = (extra) => c.ConnectionManagerRequestService.sendRequest(
            profileId, messages, maxTokens,
            { stream: false, extractData: false, signal },
            { ...override, ...extra },
        );

        try {
            return readReply(await send({}), profile?.mode === 'tc');
        } catch (err) {
            // Providers disagree about how to ask for less thinking, and a
            // rejected knob should not cost you the answer.
            if (!effort || signal?.aborted) throw err;
            console.warn(`[prompt-canvas] "${node.title}": ${source ?? 'this provider'} refused reasoning_effort "${effort}", asking again without it`);
            const reply = readReply(await send({ reasoning_effort: undefined, include_reasoning: undefined }), profile?.mode === 'tc');
            reply.thinkingIgnored = effort;
            return reply;
        }
    }

    const s = c.chatCompletionSettings ?? {};
    const raw = await c.ChatCompletionService.processRequest({
        stream: false,
        messages,
        max_tokens: maxTokens,
        model: node.model || safe(() => c.getChatCompletionModel()),
        chat_completion_source: s.chat_completion_source,
        custom_prompt_post_processing: s.custom_prompt_post_processing,
        ...(s.chat_completion_source === 'custom' && s.custom_url ? { custom_url: s.custom_url } : {}),
        ...(s.reverse_proxy ? { reverse_proxy: s.reverse_proxy, proxy_password: s.proxy_password } : {}),
        ...thinkingPayload,
    }, {}, false, signal);
    return readReply(raw, false);
}

/**
 * Pull the answer out of a provider's raw reply, along with what it cost and
 * why it stopped. "Stopped because it ran out of room" is the difference
 * between a broken extension and a budget that needs raising, so it is worth
 * carrying all the way to the screen.
 *
 * @returns {{text: string, usage: object|null, finish: string|null}}
 */
function readReply(raw, isTextCompletion) {
    const c = ctx();
    if (typeof raw === 'string') return { text: raw, usage: null, finish: null };
    if (!raw || typeof raw !== 'object') return { text: '', usage: null, finish: null };

    // Already-extracted shapes, in case a path hands one back.
    if (typeof raw.content === 'string' && !raw.choices) {
        return { text: raw.content, usage: raw.usage ?? null, finish: null };
    }

    let text = '';
    try {
        text = c.extractMessageFromData(raw, isTextCompletion ? 'textgenerationwebui' : 'openai') ?? '';
    } catch { /* fall through to the hand-rolled reads below */ }

    if (!text) {
        text = raw?.choices?.[0]?.message?.content
            ?? raw?.choices?.[0]?.text
            ?? raw?.content
            ?? raw?.text
            ?? '';
    }

    const choice = raw?.choices?.[0] ?? {};
    return {
        text: String(text ?? ''),
        usage: raw?.usage ?? null,
        finish: choice.finish_reason ?? choice.native_finish_reason ?? null,
    };
}

/** A Generate block's reply limit when it has none of its own. */
export const DEFAULT_MAX_TOKENS = 2000;

/** A plain-English account of a reply that stopped early. */
export function describeCutoff(title, usage, finish) {
    if (finish !== 'length') return null;
    const thinking = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    if (thinking && completion && thinking / completion > 0.5) {
        return `"${title}" ran out of room: ${thinking} of its ${completion} reply tokens went to the model's own hidden thinking. Turn thinking off for this block, or raise its token limit.`;
    }
    return `"${title}" ran out of room at its token limit${completion ? ` (${completion} tokens)` : ''}. Raise "Longest reply" on that block.`;
}

/**
 * Run a graph end to end.
 *
 * @param {object} graph
 * @param {object} [options]
 * @param {boolean} [options.dryRun] no model is called; placeholders stand in
 * @param {AbortSignal|null} [options.signal]
 * @param {(stage: object, index: number, total: number) => void} [options.onStage]
 * @param {(entry: object) => void} [options.onResult] called as each block finishes, so its answer can be shown while the rest run
 * @returns {Promise<{plan: object, results: Record<string,string>, thoughts: Array}>}
 */
export async function run(graph, { dryRun = false, signal = null, onStage = null, onResult = null } = {}) {
    graph = activeGraph(graph);
    const live = await gatherContext({ dryRun });
    const results = {};
    const thoughts = [];
    const failures = [];
    const cutoffs = [];
    const rescued = [];

    if (dryRun) {
        const plan = await compile(graph, { dryRun, live, results });
        return { plan, results, thoughts, failures };
    }

    // Independent blocks always go out together, up to the limit. If the
    // provider refuses that, the fallback below drops the limit to one.
    const parallel = true;
    const atOnce = Math.max(1, Number(safe(() => settings().concurrency)) || DEFAULT_AT_ONCE);
    const total = generateOrder(graph).length;
    let done = 0;
    /** Decider choices for this send, made once each, as soon as they can be. */
    const decisions = {};
    /** Generate blocks that turned out to have nothing to do. */
    const skipped = new Set();
    /** Loops: how often each has run, and which result it last acted on. */
    const loopCount = {};
    const loopSeen = {};
    const loopLast = {};
    /** Which attempt each block is on, for the labels in the chat. */
    const attemptOf = {};
    /** Bumped every time a Generate block answers, so a loop acts on each answer once. */
    const answerNo = {};
    live.loopInputs = {};
    live.excludedKeys = {};

    /**
     * Ask one Generate block its question.
     * @returns {Promise<{node: object, ok: boolean, error?: string}|null>}
     */
    async function ask(gen, { retries = 1 } = {}) {
        if (signal?.aborted) return { node: gen, ok: false, aborted: true, error: 'stopped' };
        if (!evaluateCondition(gen, live).pass) { skipped.add(gen.id); return null; }

        const built = collect(graph, gen.id, live, results, decisions);
        if (!built.messages.length) {
            // Nothing to ask. It contributes nothing, rather than leaving a
            // placeholder where its answer would have gone.
            results[gen.id] = '';
            skipped.add(gen.id);
            return null;
        }

        onStage?.(gen, done++, total);
        const startedAt = Date.now();

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                let reply = await askModel(built.messages, gen, signal);
                let sent = built.messages;
                const passes = Math.max(1, Math.min(10, Math.round(Number(gen.repeat) || 1)));
                // Repeat: each extra pass is shown its last answer and asked
                // again, so it works on its own result. It stops early when a
                // pass changes nothing, and you are not billed for the rest.
                for (let pass = 2; pass <= passes && !signal?.aborted; pass++) {
                    record(gen, reply.text, null, Date.now() - startedAt, sent, reply, { pass: pass - 1, of: passes });
                    const again = String(gen.repeatPrompt ?? '').trim()
                        || String(built.messages.at(-1)?.content ?? '').trim()
                        || 'Go over your answer again and improve it the same way. Reply with the full revised text only.';
                    sent = [...built.messages, { role: 'assistant', content: reply.text }, { role: 'user', content: again }];
                    onStage?.({ ...gen, title: `${gen.title} (pass ${pass})` }, done, total);
                    const next = await askModel(sent, gen, signal);
                    const same = gen.repeatStopWhenSame !== false && sameText(next.text, reply.text);
                    reply = next;
                    if (same) { reply.stoppedEarly = pass; break; }
                }
                results[gen.id] = reply.text;
                answerNo[gen.id] = (answerNo[gen.id] ?? 0) + 1;
                record(gen, reply.text, null, Date.now() - startedAt, sent, reply,
                    passes > 1 ? { pass: reply.stoppedEarly ?? passes, of: passes, stoppedEarly: !!reply.stoppedEarly } : null);
                const cutoff = describeCutoff(gen.title, reply.usage, reply.finish);
                if (cutoff) cutoffs.push(cutoff);
                return { node: gen, ok: true };
            } catch (err) {
                if (signal?.aborted) {
                    // Stopped by you, not a failure: no retry, nothing recorded.
                    results[gen.id] = '';
                    return { node: gen, ok: false, aborted: true, error: 'stopped' };
                }
                const why = describeError(err);
                console.error(`[prompt-canvas] "${gen.title}" failed: ${why}`, err);
                if (attempt < retries && looksTransient(why)) {
                    await sleep(700 * (attempt + 1));
                    continue;
                }
                // A failed block contributes NOTHING. It must never quietly
                // paste its own error message into the prompt you actually send.
                results[gen.id] = '';
                record(gen, '', why, Date.now() - startedAt, built.messages);
                return { node: gen, ok: false, error: why };
            }
        }
        return null;
    }

    function record(gen, text, failed, ms, sentMessages, reply = null, passInfo = null) {
        // Exactly what went to the model, after shaping, for the inspector.
        const prompt = safe(() => shapeForApi(sentMessages, gen).messages, sentMessages) ?? [];
        const at = thoughts.findIndex(t => t.id === gen.id);
        const attempt = attemptOf[gen.id] ?? 1;
        const bits = [];
        if (attempt > 1) bits.push(`attempt ${attempt}`);
        if (passInfo) bits.push(passInfo.stoppedEarly ? `stopped after pass ${passInfo.pass}: nothing left to change` : `pass ${passInfo.pass} of ${passInfo.of}`);
        const entry = {
            id: gen.id,
            title: bits.length ? `${gen.title} (${bits.join(', ')})` : gen.title,
            label: gen.label || gen.title,
            text: String(text ?? ''),
            failed,
            ms,
            show: gen.showInChat !== false,
            profile: profileName(gen.profileId || currentProfileId()),
            promptMessages: prompt.length,
            prompt,
            model: effectiveModel(gen),
            usage: reply?.usage ?? null,
            finish: reply?.finish ?? null,
            cutoff: reply ? describeCutoff(gen.title, reply.usage, reply.finish) : null,
        };
        if (at === -1) thoughts.push(entry); else thoughts[at] = entry;
        safe(() => onResult?.(entry));
    }

    const reported = new WeakSet();
    const reportDecisions = () => {
        for (const [id, d] of Object.entries(decisions)) {
            if (reported.has(d)) continue;
            reported.add(d);
            const node = graph.nodes[id];
            const attempt = attemptOf[id] ?? 1;
            const entry = {
                id,
                title: node?.title ?? d.title ?? 'Decider',
                label: `${node?.title ?? 'Decider'} \u2192 ${d.name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
                text: d.why,
                decision: d.keys ?? [d.key],
                failed: null,
                ms: 0,
                show: node?.showInChat !== false,
            };
            const at = thoughts.findIndex(t => t.id === id);
            if (at === -1) thoughts.push(entry); else thoughts[at] = entry;
            safe(() => onResult?.(entry));
        }
    };

    /**
     * Loops. A loop wire runs when its source has a fresh result: a Generate
     * block that has answered, or a Decider that chose the looping key. The
     * section between the loop's two ends is cleared and runs again, with
     * the result handed to the top. When a loop has run its limit, a Generate
     * block's answer simply carries on down the canvas, and a Decider's
     * looping key is taken off its list so it has to choose another.
     * @returns {boolean} whether anything changed
     */
    function checkLoops() {
        for (const wire of loopWires(graph)) {
            const src = graph.nodes[wire.from];
            if (!src || src.enabled === false || !graph.nodes[wire.to]) continue;
            const max = Math.max(1, Math.min(20, Math.round(Number(wire.loop.max) || 1)));
            const count = loopCount[wire.id] ?? 0;
            let token = null, text = null;
            if (src.type === NODE_TYPES.GENERATE) {
                if (!answerNo[src.id] || !String(results[src.id] ?? '').trim()) continue;
                token = `g${answerNo[src.id]}`;
                text = results[src.id];
            } else if (src.type === NODE_TYPES.DECIDER) {
                const d = decisions[src.id];
                if (!d || !picks(d, wire.port)) continue;
                token = d;
                text = textOf(collect(graph, src.id, live, results, decisions).messages);
            } else continue;
            if (loopSeen[wire.id] === token) continue;
            loopSeen[wire.id] = token;

            if (count >= max) {
                if (src.type === NODE_TYPES.DECIDER) {
                    (live.excludedKeys[src.id] ??= new Set()).add(wire.port);
                    delete decisions[src.id];
                    return true;
                }
                continue;
            }
            if (src.type === NODE_TYPES.GENERATE && wire.loop.stopWhenSame !== false
                && loopLast[wire.id] !== undefined && sameText(loopLast[wire.id], text)) {
                loopCount[wire.id] = max;           // nothing changed: this loop is done
                continue;
            }
            loopCount[wire.id] = count + 1;
            loopLast[wire.id] = text;
            live.loopInputs[wire.to] = { text, label: wire.loop.label || null };
            for (const id of loopSection(graph, wire)) {
                delete results[id];
                delete decisions[id];
                skipped.delete(id);
                attemptOf[id] = count + 2;
                for (const k of Object.keys(live.aiAnswers ?? {})) if (k.startsWith(`${id}|`)) delete live.aiAnswers[k];
            }
            return true;
        }
        return false;
    }

    // Step by step rather than a fixed plan: a Decider can only choose once
    // the text it reads exists, and the path it does not choose must cost
    // nothing. So each round asks what is still needed and what is ready.
    live.aiAnswers ??= {};
    for (let round = 0; round < 1000; round++) {
        if (signal?.aborted) break;
        live.aiWanted = new Map();
        const alive = liveNodes(graph, live, results, decisions);
        // A Decider waiting on an AI rule: ask it, then look again. Only the
        // rule that is actually needed is asked, never the whole list.
        const wanted = [...live.aiWanted].filter(([k]) => !live.aiAnswers[k]);
        if (wanted.length) {
            await Promise.all(wanted.map(async ([k, w]) => {
                safe(() => onStage?.({ id: k, title: `${w.dec.title}: asking the AI`, showInChat: false }, done, total));
                live.aiAnswers[k] = w.cond?.mode === 'sorter'
                    ? await askSorter(w.dec, w.incoming, signal)
                    : await askYesNo(w.dec, w.cond, w.incoming, signal);
            }));
            continue;
        }
        reportDecisions();
        if (checkLoops()) continue;
        const waiting = [...alive].map(id => graph.nodes[id]).filter(n =>
            n?.type === NODE_TYPES.GENERATE && n.enabled !== false && results[n.id] === undefined && !skipped.has(n.id));
        if (!waiting.length) break;
        const settled = (id) => results[id] !== undefined || skipped.has(id) || !alive.has(id) || graph.nodes[id]?.enabled === false;
        let wave = waiting.filter(g => [...generateDeps(graph, g.id)].every(settled));
        // A tie waits for its partners, so tied blocks leave together.
        const held = wave.filter(g => [...togetherGroup(graph, g.id)].some(id =>
            id !== g.id && waiting.some(w => w.id === id) && !wave.some(w => w.id === id)));
        if (held.length && held.length < wave.length) wave = wave.filter(g => !held.includes(g));
        if (!wave.length) break;

        // A tie is something you drew on purpose, so it goes out together even
        // when automatic parallel sending is switched off. The global toggle
        // governs blocks that merely happen to be independent.
        const tiedHere = wave.length > 1 && wave.some(n =>
            [...togetherGroup(graph, n.id)].filter(id => wave.some(w => w.id === id)).length > 1);

        if ((parallel || tiedHere) && wave.length > 1) {
            let outcomes = [];
            for (const batch of batches(graph, wave, atOnce, { autoParallel: parallel })) {
                outcomes.push(...await Promise.all(batch.map(g => ask(g, { retries: 1 }))));
            }

            // Some providers and proxies simply will not take concurrent
            // requests. Rather than hand back a half-empty wave, try the ones
            // that failed again, one at a time, before giving up on them.
            const stragglers = signal?.aborted ? [] : outcomes.filter(o => o && !o.ok && !o.aborted).map(o => o.node);
            if (stragglers.length) {
                console.warn(`[prompt-canvas] ${stragglers.length} block(s) failed in parallel; retrying one at a time`);
                for (const gen of stragglers) {
                    done--;
                    const again = await ask(gen, { retries: 0 });
                    if (again?.aborted) break;
                    if (again && !again.ok) failures.push({ title: gen.title, error: again.error });
                    if (again?.ok) rescued.push(gen.title);
                }
            }
        } else {
            for (const gen of wave) {
                const outcome = await ask(gen, { retries: 1 });
                if (outcome?.aborted) break;
                if (outcome && !outcome.ok) failures.push({ title: gen.title, error: outcome.error });
            }
        }
    }

    if (signal?.aborted) {
        return { plan: { ok: false, quiet: true, reason: 'Stopped before the send.', stages: [], messages: [], warnings: [], trace: [], tokens: 0 }, results, thoughts, failures, cutoffs, aborted: true };
    }

    reportDecisions();

    // Keep the answers in canvas order regardless of which finished first.
    const pos = (id) => graph.nodes[id] ?? { y: 1e9, x: 1e9 };
    thoughts.sort((a, b) => (pos(a.id).y - pos(b.id).y) || (pos(a.id).x - pos(b.id).x));

    const plan = await compile(graph, { dryRun, live, results, decisions });
    for (const f of failures) {
        plan.warnings.push(`"${f.title}" failed, so it added nothing to this prompt: ${f.error}`);
    }
    for (const c of cutoffs) plan.warnings.push(c);

    // Failed side by side, worked alone: the provider limits simultaneous
    // requests. Send one at a time from now on (ties excepted — those are
    // yours), and say so rather than failing quietly every turn.
    let throttled = false;
    if (rescued.length && atOnce > 1) {
        safe(() => { settings().concurrency = 1; saveSettings(); });
        throttled = true;
    }
    return { plan, results, thoughts, failures, cutoffs, rescued, throttled };
}

/**
 * One AI rule: show the model the text and ask a yes/no question. Short,
 * thinking off, and read forgivingly. An answer that is neither counts as NO,
 * so an unclear model sends you down the safe path rather than nowhere.
 */
async function askYesNo(dec, cond, incoming, signal) {
    const question = String(cond.question ?? '').trim();
    const pseudo = {
        id: `${dec.id}-ai`,
        title: `${dec.title}: ${question.slice(0, 40)}`,
        type: NODE_TYPES.GENERATE,
        profileId: cond.profileId || dec.profileId || null,
        model: cond.model || null,
        maxTokens: 60,
        thinking: 'off',
        instructionAsUser: true,
    };
    const messages = [
        { role: 'system', content: 'You are a strict classifier. Read the text, then answer the question with a single word: YES or NO. No explanation.' },
        { role: 'user', content: `TEXT:\n<<<\n${incoming || '(empty)'}\n>>>\n\nQUESTION: ${question}\n\nAnswer YES or NO.` },
    ];
    const read = (t) => {
        const words = String(t ?? '').toUpperCase().match(/\b(YES|NO)\b/g) ?? [];
        if (!words.length) return null;
        // The last one is its conclusion if it thought out loud anyway.
        return words[words.length - 1] === 'YES';
    };
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) return { yes: false, unclear: true, text: '' };
        try {
            const reply = await askModel(messages, pseudo, signal);
            const yes = read(reply.text);
            if (yes !== null) return { yes, unclear: false, text: reply.text, ms: Date.now() - startedAt };
            messages.push({ role: 'assistant', content: reply.text || '(nothing)' }, { role: 'user', content: 'Answer with only YES or NO.' });
        } catch (err) {
            if (signal?.aborted) return { yes: false, unclear: true, text: '' };
            console.warn(`[prompt-canvas] "${dec.title}" AI rule failed: ${describeError(err)}`);
            return { yes: false, unclear: true, error: describeError(err), text: '' };
        }
    }
    return { yes: false, unclear: true, text: '' };
}

/**
 * "AI sorts": one model call reads the text and picks which of the Decider's
 * outputs apply, going by each output's name and description. It answers
 * with output names; anything it names that is not an output is ignored.
 * @returns {{keys:string[], why:string, text:string}}
 */
export async function askSorter(dec, incoming, signal) {
    const keys = (dec.keys ?? []).filter(Boolean);
    const several = dec.sorter?.several !== false;
    const pseudo = {
        id: `${dec.id}-sorter`,
        title: `${dec.title}: AI sorts`,
        type: NODE_TYPES.GENERATE,
        profileId: dec.sorter?.profileId || dec.profileId || null,
        model: dec.sorter?.model || null,
        maxTokens: 80,
        thinking: 'off',
        instructionAsUser: true,
    };
    const list = keys.map(k => `- ${k.name || 'output'}${String(k.description ?? '').trim() ? `: ${String(k.description).trim()}` : ''}`).join('\n');
    const extra = String(dec.sorter?.instructions ?? '').trim();
    const messages = [
        { role: 'system', content: `You sort text into categories. Read the text, then answer with ${several ? 'the names of every category that applies, separated by commas' : 'the name of the single category that fits best'}. If none apply, answer NONE. Names only, no explanation.` },
        { role: 'user', content: `CATEGORIES:\n${list}\n${extra ? `\nNOTES: ${extra}\n` : ''}\nTEXT:\n<<<\n${incoming || '(empty)'}\n>>>\n\nWhich ${several ? 'categories apply' : 'category fits'}?` },
    ];
    const read = (t) => {
        const text = String(t ?? '').toLowerCase();
        // Longest names first, so "Dark red" is not read as "red" as well.
        const byLength = [...keys].sort((a, b) => String(b.name ?? '').length - String(a.name ?? '').length);
        const found = [];
        let rest = text;
        for (const k of byLength) {
            const name = String(k.name ?? '').trim().toLowerCase();
            if (!name) continue;
            const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
            if (re.test(rest)) { found.push(k.id); rest = rest.replace(re, ' '); }
        }
        const ordered = keys.filter(k => found.includes(k.id)).map(k => k.id);
        return several ? ordered : ordered.slice(0, 1);
    };
    try {
        const reply = await askModel(messages, pseudo, signal);
        const picked = read(reply.text);
        const names = keys.filter(k => picked.includes(k.id)).map(k => k.name);
        return { keys: picked, text: reply.text, why: names.length ? `the AI picked ${names.join(', ')}` : 'the AI picked none of the outputs' };
    } catch (err) {
        if (signal?.aborted) return { keys: [], why: 'stopped', text: '' };
        console.warn(`[prompt-canvas] "${dec.title}" AI sorter failed: ${describeError(err)}`);
        return { keys: [], why: `the AI could not be asked (${describeError(err)}), so it takes Otherwise`, text: '' };
    }
}

/** Two answers that differ only in spacing count as the same. */
function sameText(a, b) {
    const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    return norm(a) === norm(b);
}

/** How many requests go out at once within one wave, unless you change it. */
const DEFAULT_AT_ONCE = 2;

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/**
 * Split a wave into the batches that actually go out together.
 *
 * Blocks you have explicitly tied with a "send together" wire stay in one
 * batch even if that exceeds the concurrency limit — you asked for them to go
 * at once, and a safety default should not quietly overrule you. Everything
 * else in the wave is chunked to the limit as usual.
 */
function batches(graph, wave, size, { autoParallel = true } = {}) {
    const inWave = new Map(wave.map(n => [n.id, n]));
    const out = [];
    const placed = new Set();
    const loose = [];

    for (const node of wave) {
        if (placed.has(node.id)) continue;
        const tied = [...togetherGroup(graph, node.id)].filter(id => inWave.has(id));
        if (tied.length > 1) {
            const group = tied.map(id => inWave.get(id));
            group.forEach(n => placed.add(n.id));
            out.push(group);
        } else {
            placed.add(node.id);
            loose.push(node);
        }
    }
    out.push(...chunk(loose, autoParallel ? size : 1));
    return out.filter(b => b.length);
}

/**
 * Run one Generate block on its own and hand back what happened. This is what
 * the Test button uses: one request, the real reply or the real error, without
 * spending a chat turn to find out.
 */
export async function testBlock(graph, node, { signal = null } = {}) {
    graph = activeGraph(graph);
    const live = await gatherContext({ dryRun: true });
    const built = collect(graph, node.id, live, {});
    const { messages, note } = shapeForApi(built.messages, node);

    if (!messages.length) {
        return { ok: false, error: 'Nothing is wired into this block and it has no text of its own.', messages: [] };
    }

    const pid = node.profileId || currentProfileId();
    const startedAt = Date.now();
    try {
        const reply = await askModel(built.messages, node, signal);
        return { ok: true, text: reply.text, usage: reply.usage, finish: reply.finish,
            cutoff: describeCutoff(node.title, reply.usage, reply.finish),
            messages, note, ms: Date.now() - startedAt,
            profile: profileName(pid), ...inspectProfile(pid) };
    } catch (err) {
        return { ok: false, error: describeError(err), messages, note, ms: Date.now() - startedAt,
            profile: profileName(pid), ...inspectProfile(pid) };
    }
}

/**
 * What one Generate block would send, without sending it. The same shaping the
 * real call applies, so the preview is the thing itself rather than an
 * approximation of it.
 */
export async function previewBlock(graph, node) {
    graph = activeGraph(graph);
    const live = await gatherContext({ dryRun: true });
    const built = collect(graph, node.id, live, {});
    const { messages, note } = shapeForApi(built.messages, node);
    const pid = node.profileId || currentProfileId();
    const info = inspectProfile(pid);
    return {
        messages,
        note,
        warnings: built.warnings,
        profile: profileName(pid),
        model: node.model || info.model || null,
        maxTokens: Math.max(1, Number(node.maxTokens) || DEFAULT_MAX_TOKENS),
        thinking: node.thinking ?? 'off',
        problems: info.problems,
        chars: messages.reduce((n, m) => n + m.content.length, 0),
    };
}

/** How many model calls a graph would make before the real send. */
export function callCount(graph) {
    return maxCalls(graph);
}

/**
 * The most model calls a send can make: every Generate block's passes, plus
 * every loop running to its limit. Fewer go out when a Decider takes another
 * path or a pass changes nothing.
 */
export function maxCalls(graph) {
    graph = activeGraph(graph);
    const passes = (n) => Math.max(1, Math.min(10, Math.round(Number(n?.repeat) || 1)));
    const gens = generateOrder(graph);
    let n = gens.reduce((sum, g) => sum + passes(g), 0);
    for (const w of loopWires(graph)) {
        const max = Math.max(1, Math.min(20, Math.round(Number(w.loop.max) || 1)));
        const inSection = [...loopSection(graph, w)].map(id => graph.nodes[id]).filter(x => x?.type === NODE_TYPES.GENERATE && x.enabled !== false);
        n += max * inSection.reduce((sum, g) => sum + passes(g), 0);
    }
    return n;
}

/** How many round trips that is, once independent blocks go out together. */
export function roundTrips(graph) {
    graph = activeGraph(graph);
    const waves = generateLevels(graph);
    const atOnce = Math.max(1, Number(safe(() => settings().concurrency)) || DEFAULT_AT_ONCE);
    return waves.reduce((n, w) => n + Math.ceil(w.length / atOnce), 0);
}

export { NODE_TYPES };
