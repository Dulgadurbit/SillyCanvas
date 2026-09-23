/**
 * Prompt Canvas — showing a Generate block's answer under the reply.
 *
 * When a canvas asks the model something before the real send, that answer is
 * part of how the reply came to be. It is kept with the message and folded
 * away under it, the way SillyTavern folds reasoning: there to read, out of
 * the way when you are not reading it.
 *
 * The answers live in message.extra.promptCanvas, so they survive a reload
 * and travel with the chat file. They are never sent back to the model on a
 * later turn — only the canvas decides what gets sent.
 */

import { ctx, safe } from './state.js';

const KEY = 'promptCanvas';

/** Attach this turn's Generate answers to the message they produced. */
export function attachThoughts(messageId, thoughts) {
    const c = ctx();
    const id = Number(messageId);
    const message = c.chat?.[id];
    if (!message || !Array.isArray(thoughts) || !thoughts.length) return;

    message.extra ??= {};
    message.extra[KEY] = {
        at: Date.now(),
        thoughts: thoughts.map(t => ({
            title: t.title,
            label: t.label,
            text: String(t.text ?? ''),
            ms: t.ms ?? 0,
            failed: t.failed ?? null,
            profile: t.profile ?? null,
            model: t.model ?? null,
            usage: t.usage ?? null,
            finish: t.finish ?? null,
        })),
    };
    safe(() => c.saveChat());
    renderThoughts(id);
}

function messageElement(id) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(id))}"]`);
}

/** Draw (or redraw) the folded block under one message. */
export function renderThoughts(messageId) {
    const c = ctx();
    const id = Number(messageId);
    const data = c.chat?.[id]?.extra?.[KEY];
    const mes = messageElement(id);
    if (!mes) return;

    mes.querySelector('.pc-thoughts')?.remove();
    if (!data?.thoughts?.length) return;

    const block = document.createElement('div');
    block.className = 'pc-thoughts';

    for (const t of data.thoughts) {
        const details = document.createElement('details');
        details.className = `pc-thought${t.failed ? ' pc-thought-failed' : ''}`;

        const summary = document.createElement('summary');
        summary.className = 'pc-thought-summary';

        const label = document.createElement('span');
        label.className = 'pc-thought-label';
        label.textContent = (t.label || t.title || 'Notes') + (t.failed ? ' \u2014 failed' : '');

        const meta = document.createElement('span');
        meta.className = 'pc-thought-meta';
        const bits = [];
        if (t.model) bits.push(t.model);
        else if (t.profile) bits.push(t.profile);
        if (t.usage?.completion_tokens) {
            const think = t.usage.completion_tokens_details?.reasoning_tokens ?? 0;
            bits.push(think
                ? `${t.usage.completion_tokens} tokens, ${think} thinking`
                : `${t.usage.completion_tokens} tokens`);
        }
        if (t.finish && t.finish !== 'stop') bits.push(`stopped: ${t.finish}`);
        if (t.ms) bits.push(`${(t.ms / 1000).toFixed(1)}s`);
        meta.textContent = bits.join(' · ');

        summary.append(
            Object.assign(document.createElement('i'), { className: 'fa-solid fa-chevron-right pc-thought-arrow' }),
            label, meta,
        );

        const body = document.createElement('div');
        body.className = 'pc-thought-body';
        body.textContent = t.failed
            ? `This block failed, so it added nothing to the prompt.\n\n${t.failed}`
            : t.text;

        details.append(summary, body);
        block.append(details);
    }

    const target = mes.querySelector('.mes_block .mes_text') ?? mes.querySelector('.mes_text');
    if (target) target.before(block);
    else mes.append(block);
}

/** Redraw every message's block, after a chat loads or swaps. */
export function repaintAll() {
    const c = ctx();
    const chat = c.chat ?? [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.[KEY]) renderThoughts(i);
    }
}

/** Drop the stored answers from one message. */
export function clearThoughts(messageId) {
    const c = ctx();
    const message = c.chat?.[Number(messageId)];
    if (!message?.extra) return;
    delete message.extra[KEY];
    safe(() => c.saveChat());
    renderThoughts(messageId);
}
