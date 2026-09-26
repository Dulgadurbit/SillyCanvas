/**
 * Silly Canvas — Jev, TypeSafe's decision model.
 *
 * Jev does not write text. It is shown some text (the "state") and typed
 * questions, and answers each with probabilities: a yes/no question ("noul")
 * with how likely YES is, a pick-one question ("choice") with a probability
 * for every option. That is exactly what a Decider needs, at a fraction of a
 * chat model's cost and in about a tenth of a second.
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   { model: "jev-latest", state: "...", questions: { id: { type, instructions, criteria? } } }
 *   -> { model, answers: { id: { type, noul | choice, probabilities?, confidence? } }, usage }
 *
 * TypeSafe's API does not answer a web page directly (no CORS), so from
 * inside SillyTavern the call goes through SillyTavern's own CORS proxy
 * (/proxy/<url>). That proxy is off by default: `enableCorsProxy: true` in
 * config.yaml switches it on.
 */

import { ctx, safe, settings, save } from './state.js?v=0.17.0';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export function jevSettings() {
    const s = settings();
    s.jev ??= {};
    return s.jev;
}

export function jevReady() {
    return !!String(safe(() => jevSettings().key) ?? '').trim();
}

/** Why a Jev call failed, in words you can act on. */
export class JevError extends Error {}

/** Only for tests: stand in for fetch. */
let fetchImpl = null;
export function setJevFetch(fn) { fetchImpl = fn; }
const doFetch = (...a) => (fetchImpl ?? globalThis.fetch)(...a);

/**
 * Ask Jev. Tries the API directly first (in case the browser is allowed to),
 * then through SillyTavern's CORS proxy, and remembers which worked.
 * @param {string|object|Array} state   the text (or JSON) to judge
 * @param {Record<string, object>} questions
 * @returns {Promise<{answers: Record<string, object>, usage?: object, model?: string, ms: number}>}
 */
export async function askJev(state, questions, { signal = null } = {}) {
    const key = String(jevSettings().key ?? '').trim();
    if (!key) throw new JevError('No TypeSafe API key. Add it in Extensions → Silly Canvas → Jev.');
    const body = JSON.stringify({ model: jevSettings().model || JEV_MODEL, state: state === '' ? '(empty)' : state, questions });
    const started = Date.now();
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

    const direct = () => doFetch(JEV_URL, { method: 'POST', headers: auth, body, signal });
    const proxied = () => {
        const headers = { ...(safe(() => ctx().getRequestHeaders()) ?? {}), ...auth };
        return doFetch(`/proxy/${JEV_URL}`, { method: 'POST', headers, body, signal });
    };

    let res;
    const s = jevSettings();
    if (s.route !== 'proxy') {
        try {
            res = await direct();
        } catch (err) {
            if (signal?.aborted) throw err;
            res = null;             // the browser refused it: CORS
        }
    }
    if (!res) {
        try {
            res = await proxied();
        } catch (err) {
            if (signal?.aborted) throw err;
            throw new JevError(`Could not reach Jev through SillyTavern (${err?.message ?? err}).`);
        }
        if (res.status === 404) {
            const text = await res.text().catch(() => '');
            if (/cors proxy is disabled/i.test(text) || !text.trim().startsWith('{')) {
                throw new JevError('Jev can only be reached through SillyTavern’s CORS proxy, which is off. Set "enableCorsProxy: true" in SillyTavern’s config.yaml and restart SillyTavern.');
            }
            throw new JevError(`Jev answered 404: ${text.slice(0, 200)}`);
        }
        if (s.route !== 'proxy') { s.route = 'proxy'; save(); }
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try { const j = JSON.parse(text); detail = j?.error?.message ?? j?.detail ?? j?.message ?? text; if (typeof detail !== 'string') detail = JSON.stringify(detail); } catch { /* plain text */ }
        const why = {
            401: 'the TypeSafe API key was refused',
            422: 'Jev could not read the question',
            429: 'too many requests to Jev just now',
            529: 'Jev is overloaded just now',
        }[res.status] ?? `Jev answered ${res.status}`;
        throw new JevError(`${why}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    if (!json?.answers) throw new JevError('Jev sent back no answers.');
    return { answers: json.answers, usage: json.usage ?? null, model: json.model ?? null, ms: Date.now() - started };
}

const pct = (p) => `${Math.round(100 * p)}%`;

/**
 * One yes/no question. YES when Jev is at least `threshold` sure.
 * @returns {Promise<{yes: boolean, p: number, text: string, ms: number}>}
 */
export async function jevYesNo(text, question, { threshold = 0.5, signal = null } = {}) {
    const { answers, ms } = await askJev(String(text ?? ''), { q: { type: 'noul', instructions: String(question ?? '').trim() || 'Is this true?' } }, { signal });
    const p = Number(answers?.q?.noul);
    if (!Number.isFinite(p)) throw new JevError('Jev did not answer the question.');
    const t = Number(threshold) || 0.5;
    return { yes: p >= t, p, text: `Jev: ${pct(p)} sure it is YES (YES from ${pct(t)})`, ms };
}

/**
 * Sort text into a Decider's outputs.
 *  - several: every output is its own yes/no question, all asked in one call;
 *    each that Jev is at least `threshold` sure of fires.
 *  - one: a single pick-one question over the outputs plus "none of these";
 *    the pick fires if it is not "none" and reaches `threshold`.
 * @param {Array<{id:string, name?:string, description?:string}>} keys
 * @returns {Promise<{keys: string[], why: string, text: string, probs: Record<string, number>}>}
 */
export async function jevSort(text, keys, { several = true, instructions = '', threshold = 0.5, signal = null } = {}) {
    const t = Number(threshold) || 0.5;
    const extra = String(instructions ?? '').trim();
    keys = keys.filter(Boolean);
    if (!keys.length) return { keys: [], why: 'there are no outputs to choose from', text: '', probs: {} };
    const probs = {};
    if (several) {
        const questions = {};
        keys.forEach((k, i) => {
            const d = String(k.description ?? '').trim();
            questions[`k${i}`] = {
                type: 'noul',
                instructions: `${d || `This text is about: ${k.name || 'this'}`}${extra ? `\n\n(${extra})` : ''}`,
            };
        });
        const { answers } = await askJev(String(text ?? ''), questions, { signal });
        keys.forEach((k, i) => { probs[k.id] = Number(answers?.[`k${i}`]?.noul) || 0; });
        const picked = keys.filter(k => probs[k.id] >= t).map(k => k.id);
        return { keys: picked, probs, text: describe(keys, probs), why: whyOf(keys, picked, probs, t) };
    }

    // One pick: the option names must be unique for Jev.
    const names = new Map();
    const criteria = {};
    keys.forEach((k, i) => {
        let n = String(k.name ?? '').trim() || `output ${i + 1}`;
        while (criteria[n] !== undefined || n === 'none of these') n = `${n} (${i + 1})`;
        names.set(n, k.id);
        criteria[n] = String(k.description ?? '').trim() || n;
    });
    criteria['none of these'] = 'None of the other options fits the text.';
    const { answers } = await askJev(String(text ?? ''), {
        pick: { type: 'choice', instructions: `Which of these fits the text best?${extra ? `\n\n${extra}` : ''}`, criteria },
    }, { signal });
    const a = answers?.pick ?? {};
    for (const [n, id] of names) probs[id] = Number(a.probabilities?.[n]) || 0;
    const id = names.get(a.choice);
    const picked = id && probs[id] >= t ? [id] : [];
    return { keys: picked, probs, text: describe(keys, probs), why: whyOf(keys, picked, probs, t) };
}

function describe(keys, probs) {
    return `Jev: ${keys.map(k => `${k.name || 'output'} ${pct(probs[k.id] ?? 0)}`).join(', ')}`;
}

function whyOf(keys, picked, probs, t) {
    const scores = keys.map(k => `${k.name || 'output'} ${pct(probs[k.id] ?? 0)}`).join(', ');
    if (!picked.length) return `Jev was not ${pct(t)} sure of any output (${scores})`;
    const names = keys.filter(k => picked.includes(k.id)).map(k => k.name || 'output');
    return `Jev picked ${names.join(', ')} (${scores})`;
}
