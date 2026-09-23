/**
 * Prompt Canvas — the executor.
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

import { ctx, safe, settings, save as saveSettings, NODE_TYPES, togetherGroup } from './state.js?v=0.3.0';
import { compile, collect, generateOrder, generateLevels, gatherContext, evaluateCondition } from './compile.js?v=0.3.0';

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

/** The provider a Generate block will actually go through. */
export function sourceForBlock(node) {
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
export function shapeForApi(messages) {
    const out = messages
        .filter(m => m && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ ...m }));

    if (!out.length) return { messages: out, note: null };

    const hasTurn = out.some(m => m.role === 'user' || m.role === 'assistant');
    if (hasTurn) return { messages: out, note: null };

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
    const { messages, note } = shapeForApi(rawMessages);
    if (note) console.log(`[prompt-canvas] "${node.title}": ${note}`);
    if (!messages.length) throw new Error('nothing to send');

    const c = ctx();
    const maxTokens = Math.max(1, Number(node.maxTokens) || 500);
    const profileId = node.profileId || currentProfileId();

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
    const waves = generateLevels(graph);
    const total = waves.reduce((n, w) => n + w.length, 0);
    let done = 0;

    /**
     * Ask one Generate block its question.
     * @returns {Promise<{node: object, ok: boolean, error?: string}|null>}
     */
    async function ask(gen, { retries = 1 } = {}) {
        if (signal?.aborted) return { node: gen, ok: false, aborted: true, error: 'stopped' };
        if (!evaluateCondition(gen, live).pass) return null;

        const built = collect(graph, gen.id, live, results);
        if (!built.messages.length) return null;

        onStage?.(gen, done++, total);
        const startedAt = Date.now();

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const reply = await askModel(built.messages, gen, signal);
                results[gen.id] = reply.text;
                record(gen, reply.text, null, Date.now() - startedAt, built.messages, reply);
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

    function record(gen, text, failed, ms, sentMessages, reply = null) {
        // Exactly what went to the model, after shaping, for the inspector.
        const prompt = safe(() => shapeForApi(sentMessages).messages, sentMessages) ?? [];
        const at = thoughts.findIndex(t => t.id === gen.id);
        const entry = {
            id: gen.id,
            title: gen.title,
            label: gen.label || gen.title,
            text: String(text ?? ''),
            failed,
            ms,
            show: gen.showInChat !== false,
            profile: profileName(gen.profileId || currentProfileId()),
            promptMessages: prompt.length,
            prompt,
            model: gen.model || inspectProfile(gen.profileId || currentProfileId()).model || null,
            usage: reply?.usage ?? null,
            finish: reply?.finish ?? null,
        };
        if (at === -1) thoughts.push(entry); else thoughts[at] = entry;
        safe(() => onResult?.(entry));
    }

    for (const wave of waves) {
        if (signal?.aborted) break;
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

    // Keep the answers in canvas order regardless of which finished first.
    const order = generateOrder(graph).map(n => n.id);
    thoughts.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    const plan = await compile(graph, { dryRun, live, results });
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
    const live = await gatherContext({ dryRun: true });
    const built = collect(graph, node.id, live, {});
    const { messages, note } = shapeForApi(built.messages);

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
    const live = await gatherContext({ dryRun: true });
    const built = collect(graph, node.id, live, {});
    const { messages, note } = shapeForApi(built.messages);
    const pid = node.profileId || currentProfileId();
    const info = inspectProfile(pid);
    return {
        messages,
        note,
        warnings: built.warnings,
        profile: profileName(pid),
        model: node.model || info.model || null,
        maxTokens: Math.max(1, Number(node.maxTokens) || 500),
        thinking: node.thinking ?? 'off',
        problems: info.problems,
        chars: messages.reduce((n, m) => n + m.content.length, 0),
    };
}

/** How many model calls a graph would make before the real send. */
export function callCount(graph) {
    return generateOrder(graph).length;
}

/** How many round trips that is, once independent blocks go out together. */
export function roundTrips(graph) {
    const waves = generateLevels(graph);
    const atOnce = Math.max(1, Number(safe(() => settings().concurrency)) || DEFAULT_AT_ONCE);
    return waves.reduce((n, w) => n + Math.ceil(w.length / atOnce), 0);
}

export { NODE_TYPES };
