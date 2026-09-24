/**
 * A small, safe formula language for State blocks, wire conditions and
 * Decider rules. No eval: formulas are parsed here and can only read the
 * names they are given.
 *
 *   energy - 1            numbers and names
 *   hunger >= 7 && !fed   comparisons, && || ! (also "and", "or", "not")
 *   turn % 5 == 0         + - * / %  and ( )
 *   min(10, hunger + 2)   min max abs round floor ceil clamp(x, lo, hi)
 *   mood == "angry"       text in quotes
 *   energy <= 2 ? 1 : 0   a ? b : c
 *
 * Unknown names are 0, so a typo gives a wrong number rather than an error
 * mid-send; check() reports them for the editor.
 */

const FUNCS = {
    min: (...a) => Math.min(...a.map(Number)),
    max: (...a) => Math.max(...a.map(Number)),
    abs: (x) => Math.abs(Number(x)),
    round: (x) => Math.round(Number(x)),
    floor: (x) => Math.floor(Number(x)),
    ceil: (x) => Math.ceil(Number(x)),
    clamp: (x, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(x))),
};

function tokenize(src) {
    const out = [];
    const s = String(src ?? '');
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9.]/.test(c)) {
            const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
            if (!m) throw new Error(`bad number at ${i + 1}`);
            out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
            const w = m[0];
            const lw = w.toLowerCase();
            if (lw === 'and') out.push({ t: 'op', v: '&&' });
            else if (lw === 'or') out.push({ t: 'op', v: '||' });
            else if (lw === 'not') out.push({ t: 'op', v: '!' });
            else if (lw === 'true' || lw === 'false') out.push({ t: 'num', v: lw === 'true' ? 1 : 0 });
            else out.push({ t: 'name', v: w });
            i += w.length; continue;
        }
        if (c === '"' || c === "'") {
            const end = s.indexOf(c, i + 1);
            if (end < 0) throw new Error('a quote is not closed');
            out.push({ t: 'str', v: s.slice(i + 1, end) }); i = end + 1; continue;
        }
        const two = s.slice(i, i + 2);
        if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
        if ('+-*/%<>!()?:,='.includes(c)) { out.push({ t: 'op', v: c === '=' ? '==' : c }); i++; continue; }
        throw new Error(`unexpected "${c}"`);
    }
    return out;
}

const BIN = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

/** Parse a formula into a tree. Throws with a readable message. */
export function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const eat = (v) => {
        const t = toks[p];
        if (!t || t.v !== v) throw new Error(`expected "${v}"`);
        p++;
    };
    function primary() {
        const t = toks[p++];
        if (!t) throw new Error('the formula ends too early');
        if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
        if (t.t === 'name') {
            if (peek()?.v === '(') {
                p++;
                const args = [];
                if (peek()?.v !== ')') {
                    args.push(expr());
                    while (peek()?.v === ',') { p++; args.push(expr()); }
                }
                eat(')');
                if (!FUNCS[t.v.toLowerCase()]) throw new Error(`unknown function "${t.v}"`);
                return { k: 'call', f: t.v.toLowerCase(), args };
            }
            return { k: 'var', v: t.v };
        }
        if (t.v === '(') { const e = expr(); eat(')'); return e; }
        if (t.v === '-') return { k: 'neg', e: unary() };
        if (t.v === '!') return { k: 'not', e: unary() };
        throw new Error(`unexpected "${t.v}"`);
    }
    function unary() { return primary(); }
    function binary(min) {
        let left = unary();
        for (;;) {
            const t = peek();
            if (!t || t.t !== 'op' || !BIN[t.v] || BIN[t.v] < min) return left;
            p++;
            const right = binary(BIN[t.v] + 1);
            left = { k: 'bin', op: t.v, a: left, b: right };
        }
    }
    function expr() {
        const c = binary(1);
        if (peek()?.v === '?') {
            p++;
            const a = expr();
            eat(':');
            const b = expr();
            return { k: 'if', c, a, b };
        }
        return c;
    }
    if (!toks.length) throw new Error('empty formula');
    const tree = expr();
    if (p < toks.length) throw new Error(`unexpected "${toks[p].v}"`);
    return tree;
}

const cache = new Map();
function compiled(src) {
    const key = String(src ?? '');
    if (!cache.has(key)) {
        let v;
        try { v = { tree: parse(key) }; } catch (err) { v = { error: err.message }; }
        if (cache.size > 500) cache.clear();
        cache.set(key, v);
    }
    return cache.get(key);
}

function lookup(vars, name) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(vars)) if (k.toLowerCase() === lower) return vars[k];
    return 0;
}

function run(n, vars) {
    switch (n.k) {
        case 'lit': return n.v;
        case 'var': return lookup(vars, n.v);
        case 'neg': return -Number(run(n.e, vars));
        case 'not': return truthy(run(n.e, vars)) ? 0 : 1;
        case 'if': return truthy(run(n.c, vars)) ? run(n.a, vars) : run(n.b, vars);
        case 'call': return FUNCS[n.f](...n.args.map(a => run(a, vars)));
        case 'bin': {
            if (n.op === '&&') return truthy(run(n.a, vars)) && truthy(run(n.b, vars)) ? 1 : 0;
            if (n.op === '||') return truthy(run(n.a, vars)) || truthy(run(n.b, vars)) ? 1 : 0;
            const a = run(n.a, vars), b = run(n.b, vars);
            const text = typeof a === 'string' || typeof b === 'string';
            switch (n.op) {
                case '==': return (text ? String(a).toLowerCase() === String(b).toLowerCase() : Number(a) === Number(b)) ? 1 : 0;
                case '!=': return (text ? String(a).toLowerCase() !== String(b).toLowerCase() : Number(a) !== Number(b)) ? 1 : 0;
                case '<': return Number(a) < Number(b) ? 1 : 0;
                case '<=': return Number(a) <= Number(b) ? 1 : 0;
                case '>': return Number(a) > Number(b) ? 1 : 0;
                case '>=': return Number(a) >= Number(b) ? 1 : 0;
                case '+': return text ? `${a}${b}` : Number(a) + Number(b);
                case '-': return Number(a) - Number(b);
                case '*': return Number(a) * Number(b);
                case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
                case '%': return Number(b) === 0 ? 0 : ((Number(a) % Number(b)) + Number(b)) % Number(b);
            }
        }
    }
    return 0;
}

export const truthy = (v) => typeof v === 'string' ? v.length > 0 : Number(v) !== 0 && !Number.isNaN(Number(v));

/** Work out a formula. A formula that does not parse gives `fallback`. */
export function evaluate(src, vars = {}, fallback = 0) {
    const c = compiled(src);
    if (!c.tree) return fallback;
    try { return run(c.tree, vars); } catch { return fallback; }
}

/** Whether a formula holds. */
export function holds(src, vars = {}) {
    return truthy(evaluate(src, vars, 0));
}

/**
 * For the editor: whether a formula parses, and the names it uses that are
 * not known.
 * @returns {{ok:boolean, error?:string, unknown:string[]}}
 */
export function check(src, known = []) {
    const c = compiled(src);
    if (!c.tree) return { ok: false, error: c.error, unknown: [] };
    const names = new Set();
    const walk = (n) => {
        if (!n) return;
        if (n.k === 'var') names.add(n.v);
        for (const k of ['e', 'c', 'a', 'b']) walk(n[k]);
        (n.args ?? []).forEach(walk);
    };
    walk(c.tree);
    const low = new Set(known.map(k => k.toLowerCase()));
    return { ok: true, unknown: [...names].filter(n => !low.has(n.toLowerCase())) };
}
