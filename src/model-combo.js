/**
 * Silly Canvas — a model picker you can search.
 *
 * Providers such as OpenRouter offer hundreds of models, and a plain <select>
 * makes you scroll for them. This is one text box: click it and the whole
 * list drops down, type and it narrows (every word you type must appear in
 * the id, the name or the provider group), arrows and Enter pick. Anything
 * typed that is not in the list can still be used as a model id, because a
 * provider can offer a model the list has not caught up with yet.
 */

const MAX_ROWS = 250;

const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

/**
 * @param {object} o
 * @param {string|null} o.value           the model chosen now, or null for "same as the connection"
 * @param {Array<{id:string,label?:string,group?:string|null}>} o.models
 * @param {string} [o.sameLabel]          what the empty choice is called
 * @param {(id: string|null) => void} o.onPick
 * @param {boolean} [o.autofocus]         open the list straight away (the canvas popover)
 * @param {() => void} [o.onClose]        the list closed without a pick
 * @returns {HTMLElement}
 */
export function modelCombo({ value = null, models = [], sameLabel = 'same as the connection', onPick, autofocus = false, onClose = null }) {
    const wrap = mk('div', 'pc-combo');
    const box = mk('div', 'pc-combo-box');
    const input = mk('input', 'text_pole pc-combo-input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.placeholder = value ? '' : sameLabel;
    input.value = value ?? '';
    input.title = 'Click to see every model, type to search. Enter picks; anything typed that is not listed is used as a model id.';
    const caret = mk('i', 'fa-solid fa-chevron-down pc-combo-caret');
    box.append(input, caret);
    const list = mk('div', 'pc-combo-list');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.append(box, list);

    // De-duplicated, in the provider's order.
    const seen = new Set();
    const all = [];
    for (const m of models) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        all.push({ id: m.id, label: m.label || m.id, group: m.group || null });
    }
    if (value && !seen.has(value)) all.push({ id: value, label: `${value} (not in the list)`, group: null });

    let rows = [];
    let active = 0;
    let open = false;
    let picked = false;

    const matches = (m, words) => {
        const hay = `${m.id} ${m.label} ${m.group ?? ''}`.toLowerCase();
        return words.every(w => hay.includes(w));
    };

    function paint(query) {
        const q = String(query ?? '').trim();
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        const found = words.length ? all.filter(m => matches(m, words)) : all;
        rows = [];
        if (!words.length) rows.push({ id: '', label: sameLabel, same: true });
        rows.push(...found.slice(0, MAX_ROWS));
        if (q && !all.some(m => m.id === q)) rows.push({ id: q, label: `Use "${q}" as the model id`, custom: true });
        active = Math.min(active, Math.max(0, rows.length - 1));
        // When the list opens on the current choice, start there.
        if (!words.length) {
            const at = rows.findIndex(r => (r.id || null) === (value || null));
            if (at >= 0) active = at;
        }

        list.innerHTML = '';
        if (!all.length && !q) {
            list.append(mk('div', 'pc-combo-empty', 'No model list loaded yet. Load it, or type a model id and press Enter.'));
        }
        let lastGroup;
        rows.forEach((r, i) => {
            if (!r.same && !r.custom && r.group !== lastGroup) {
                lastGroup = r.group;
                if (r.group) list.append(mk('div', 'pc-combo-group', r.group));
            }
            const row = mk('div', `pc-combo-row${i === active ? ' pc-active' : ''}${(r.id || null) === (value || null) && !r.custom ? ' pc-current' : ''}${r.same ? ' pc-combo-same' : ''}${r.custom ? ' pc-combo-custom' : ''}`);
            row.setAttribute('role', 'option');
            row.dataset.i = String(i);
            if (r.same || r.custom) row.textContent = r.label;
            else {
                row.append(mk('span', 'pc-combo-label', r.label));
                if (r.label !== r.id) row.append(mk('span', 'pc-combo-id', r.id));
            }
            row.title = r.same ? 'Follow the connection: this block uses whatever model it is set to' : r.id;
            list.append(row);
        });
        if (found.length > MAX_ROWS) list.append(mk('div', 'pc-combo-empty', `${found.length - MAX_ROWS} more — keep typing to narrow it down`));
        if (words.length && !found.length) list.prepend(mk('div', 'pc-combo-empty', 'No model in the list matches.'));
    }

    function show() {
        if (open) return;
        open = true;
        list.hidden = false;
        wrap.classList.add('pc-combo-open');
        input.setAttribute('aria-expanded', 'true');
        paint('');
        scrollToActive();
    }

    function hide() {
        if (!open) return;
        open = false;
        list.hidden = true;
        wrap.classList.remove('pc-combo-open');
        input.setAttribute('aria-expanded', 'false');
        input.value = value ?? '';
        if (!picked) onClose?.();
    }

    function scrollToActive() {
        const row = list.querySelector('.pc-combo-row.pc-active');
        row?.scrollIntoView?.({ block: 'nearest' });
    }

    function move(by) {
        if (!rows.length) return;
        active = (active + by + rows.length) % rows.length;
        for (const r of list.querySelectorAll('.pc-combo-row')) r.classList.toggle('pc-active', Number(r.dataset.i) === active);
        scrollToActive();
    }

    function pick(r) {
        if (!r) return;
        picked = true;
        value = r.id || null;
        input.placeholder = value ? '' : sameLabel;
        hide();
        input.blur();
        onPick?.(value);
    }

    input.addEventListener('focus', () => { show(); input.select(); });
    input.addEventListener('mousedown', (e) => { e.stopPropagation(); if (document.activeElement === input) show(); });
    input.addEventListener('input', () => { if (!open) show(); active = 0; paint(input.value); });
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();          // keep canvas shortcuts (Delete, Ctrl+Z) out of the search box
        if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); else move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); if (open) pick(rows[active]); else show(); }
        else if (e.key === 'Escape') { e.preventDefault(); hide(); input.blur(); }
        else if (e.key === 'Tab') { hide(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) hide(); }, 120));
    caret.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); if (open) { hide(); input.blur(); } else input.focus(); });
    // mousedown, not click: picking must happen before the input loses focus.
    list.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const row = e.target.closest('.pc-combo-row');
        if (row) pick(rows[Number(row.dataset.i)]);
    });

    // Open at once, even if the browser holds back the focus event (an unfocused window).
    if (autofocus) setTimeout(() => { input.focus(); show(); input.select(); }, 0);
    wrap._input = input;
    return wrap;
}
