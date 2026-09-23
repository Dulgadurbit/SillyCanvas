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

import { ctx, safe } from './state.js?v=0.6.0';

const KEY = 'promptCanvas';

/**
 * The prompt each answer was asked with, kept in memory only. A prompt with
 * the chat history in it can be larger than the reply many times over, and
 * saving one per block per turn would swell the chat file quickly — so it is
 * there to inspect for this session, and gone after a reload.
 */
const prompts = new WeakMap();

/** Attach this turn's Generate answers to the message they produced. */
export function attachThoughts(messageId, thoughts) {
    const c = ctx();
    const id = Number(messageId);
    const message = c.chat?.[id];
    if (!message || !Array.isArray(thoughts) || !thoughts.length) return;

    message.extra ??= {};
    prompts.set(message, thoughts.map(t => t.prompt ?? null));
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
            decision: t.decision ?? null,
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

    const asked = prompts.get(c.chat[id]) ?? [];
    data.thoughts.forEach((t, i) => block.append(thoughtElement(t, { prompt: asked[i] ?? null })));

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

/**
 * One answer as a folded <details>. Shared by the finished view under a reply
 * and the live panel shown while blocks run, so the two look the same.
 */
function thoughtElement(t, { open = false, pending = false, prompt = t.prompt ?? null } = {}) {
    const details = document.createElement('details');
    details.className = `pc-thought${t.failed ? ' pc-thought-failed' : ''}${pending ? ' pc-thought-pending' : ''}${t.decision ? ' pc-thought-decision' : ''}`;
    details.open = open;

    const summary = document.createElement('summary');
    summary.className = 'pc-thought-summary';

    const label = document.createElement('span');
    label.className = 'pc-thought-label';
    // Always name the block that wrote it. A custom heading, when you gave
    // one, goes beside the name rather than replacing it.
    const custom = t.label && t.label !== t.title && t.label !== 'Notes' && !t.decision ? t.label : '';
    label.textContent = (t.decision ? (t.label || t.title) : (t.title || t.label || 'Generate')) + (t.failed ? ' — failed' : '');
    if (custom) {
        const sub = document.createElement('span');
        sub.className = 'pc-thought-sub';
        sub.textContent = custom;
        label.append(' ', sub);
    }

    const meta = document.createElement('span');
    meta.className = 'pc-thought-meta';
    const bits = [];
    if (pending) bits.push('thinking…');
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

    const arrow = document.createElement('i');
    arrow.className = pending ? 'fa-solid fa-spinner fa-spin pc-thought-arrow'
        : t.decision ? 'fa-solid fa-code-fork pc-thought-arrow'
        : 'fa-solid fa-chevron-right pc-thought-arrow';
    summary.append(arrow, label, meta);

    const body = document.createElement('div');
    body.className = 'pc-thought-body';
    body.textContent = t.failed
        ? `This block failed, so it added nothing to the prompt.\n\n${t.failed}`
        : (t.text ?? '');

    details.append(summary, body);
    if (Array.isArray(prompt) && prompt.length) details.append(promptInspector(prompt));
    return details;
}

/** How much of one message to show before "Show all". */
const CLIP = 1500;

/**
 * "What this block was asked": every message that went to the model, with
 * its role. Built only when opened, so a long chat history costs nothing
 * until you look at it.
 */
function promptInspector(messages) {
    const box = document.createElement('details');
    box.className = 'pc-thought-prompt';
    const chars = messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
    const sum = document.createElement('summary');
    sum.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> ';
    sum.append(`What it was asked · ${messages.length} message${messages.length === 1 ? '' : 's'}, ${chars.toLocaleString()} characters`);
    box.append(sum);

    box.addEventListener('toggle', () => {
        if (!box.open || box.dataset.built) return;
        box.dataset.built = '1';
        for (const m of messages) {
            const row = document.createElement('div');
            row.className = `pc-tp-msg pc-tp-${m.role || 'system'}`;
            const role = document.createElement('div');
            role.className = 'pc-tp-role';
            role.textContent = (m.role || 'system') + (m.name ? ` · ${m.name}` : '');
            const text = document.createElement('div');
            text.className = 'pc-tp-text';
            const full = String(m.content ?? '');
            text.textContent = full.length > CLIP ? full.slice(0, CLIP) + '…' : full;
            row.append(role, text);
            if (full.length > CLIP) {
                const more = document.createElement('a');
                more.className = 'pc-tp-more';
                more.href = 'javascript:void(0)';
                more.textContent = `Show all ${full.length.toLocaleString()} characters`;
                more.addEventListener('click', (e) => { e.preventDefault(); text.textContent = full; more.remove(); });
                row.append(more);
            }
            box.append(row);
        }
    });
    return box;
}

/**
 * The live panel: Generate answers appear at the bottom of the chat as each
 * block finishes, so you can read them while the rest run and the reply is
 * written. It lives in the DOM only — never in chat[] — so it cannot be sent
 * to the model, saved into the chat file, or left behind in the chat if the
 * run is stopped. When the reply arrives the answers are attached to it the
 * usual way and this panel goes.
 */
export const livePanel = (() => {
    let box = null;
    const rows = new Map();

    const scroll = () => safe(() => {
        const chat = document.getElementById('chat');
        if (chat && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 300) chat.scrollTop = chat.scrollHeight;
    });

    const ensure = () => {
        if (box?.isConnected) return box;
        const chat = document.getElementById('chat');
        if (!chat) return null;
        box = document.createElement('div');
        box.className = 'pc-thoughts pc-live';
        chat.append(box);
        return box;
    };

    const put = (id, el) => {
        const old = rows.get(id);
        if (old?.isConnected) old.replaceWith(el); else ensure()?.append(el);
        rows.set(id, el);
        scroll();
    };

    return {
        /** A block has been sent. */
        running(node) {
            if (node.showInChat === false) return;
            put(node.id, thoughtElement({ title: node.title, label: node.label || node.title, model: node.model || null }, { pending: true }));
        },
        /** A block has answered (or failed). Opened, so it can be read at once. */
        result(entry) {
            if (!entry.show) { rows.get(entry.id)?.remove(); rows.delete(entry.id); return; }
            put(entry.id, thoughtElement(entry, { open: true }));
        },
        /** Stopped: keep the answers that came back, drop the spinners. */
        dropPending() {
            for (const [id, el] of rows) if (el.classList.contains('pc-thought-pending')) { el.remove(); rows.delete(id); }
            if (box && !box.children.length) this.clear();
        },
        clear() {
            box?.remove();
            box = null;
            rows.clear();
        },
        get active() { return !!box?.isConnected; },
    };
})();
