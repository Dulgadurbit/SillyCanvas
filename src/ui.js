/**
 * Silly Canvas — the panel.
 *
 * Layout: library on the left, canvas in the middle, inspector on the right,
 * a compile preview that slides up from the bottom. The preview is not a
 * nicety: it is the only honest answer to "what is this graph actually going
 * to send", and it is one click away at all times.
 */

import {
    ctx, safe, settings, save, NODE_TYPES, WIRE_KINDS, ROLES,
    allGraphs, getGraph, createGraph, duplicateGraph, deleteGraph, touchGraph,
    addNode, removeNode, outputNode, connect, disconnect, resolveGraph,
    chatBinding, setChatBinding, characterBinding, setCharacterBinding,
    exportGraph, importGraph, blankGraph, isFolderCollapsed, setFolderCollapsed, togetherGroup,
    newDeciderKey, removeDeciderKey, onGraphTouched, duplicateNode,
} from './state.js?v=0.11.0';
import { applyTheme } from './theme.js?v=0.11.0';
import { renderThemeEditor } from './theme-editor.js?v=0.11.0';
import * as H from './history.js?v=0.11.0';
import * as L from './library.js?v=0.11.0';
import { compile, gatherContext, resolveNode, textOf, generateLevels, emissionCounts, wirePreview, countTokens, routingMode, explainDecider, deciderInputList, collect } from './compile.js?v=0.11.0';
import { LORE_POSITIONS } from './lore.js?v=0.11.0';
import { DEFAULT_SELECT, isActive as selectActive, selectLabel } from './select.js?v=0.11.0';
import { run, profileName, effectiveModel, callCount, testBlock, shapeForApi, inspectProfile, modelsForSource, sourceForBlock, cachedModels, fetchModelList, previewBlock } from './run.js?v=0.11.0';
import { Canvas, WIRE_LABEL, TYPE_LABEL } from './canvas.js?v=0.11.0';

let root = null;
let canvas = null;
let current = null;      // graph in view
let selected = null;     // node or wire
let selectedKind = null;

export const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function toast(msg, type = 'info') {
    const t = safe(() => globalThis.toastr);
    if (t) t[type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'](msg, 'Silly Canvas');
    else console.log('[Silly Canvas]', msg);
}

export async function confirmBox(text, title = 'Silly Canvas') {
    const c = ctx();
    try {
        const res = await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Yes', cancelButton: 'No', title });
        return res === c.POPUP_RESULT.AFFIRMATIVE;
    } catch {
        return confirm(text);
    }
}

export async function inputBox(text, value = '') {
    const c = ctx();
    try {
        const res = await c.callGenericPopup(text, c.POPUP_TYPE.INPUT, value, { title: 'Silly Canvas' });
        return (res === false || res === null || res === undefined) ? null : String(res);
    } catch {
        return prompt(text, value);
    }
}

export function profiles() {
    const cm = safe(() => ctx().extensionSettings?.connectionManager?.profiles) ?? [];
    return Array.isArray(cm) ? cm : [];
}

let lastPlan = null;
let liveCache = null;

/**
 * A snapshot of everything the compiler resolves from (character fields, world
 * info, chat, injections), kept so the inspector can show what a SillyTavern
 * prompt currently contains without re-scanning on every keystroke.
 */
async function refreshLive() {
    try { liveCache = await gatherContext({ dryRun: true }); }
    catch { liveCache = null; }
    return liveCache;
}

/**
 * Which wave a Generate block is in, and who goes out with it.
 *
 * There is no "parallel wire", and there should not be: a wire means one
 * block's reply feeds another, which forces an order. Blocks run together
 * precisely when nothing wires them together. This makes that visible.
 */
function waveInfo(node) {
    if (!current) return null;
    const waves = generateLevels(current);
    if (!waves.length) return null;
    const total = waves.reduce((n, w) => n + w.length, 0);
    for (const [i, wave] of waves.entries()) {
        if (!wave.some(n => n.id === node.id)) continue;
        const group = togetherGroup(current, node.id);
        const tied = wave.some(n => n.id !== node.id && group.has(n.id));
        const auto = true;
        return {
            wave: i + 1,
            waves: waves.length,
            total,
            tied,
            // A tie is explicit and outranks the global toggle.
            willRunTogether: tied || auto,
            siblings: wave.filter(n => n.id !== node.id).map(n => n.title),
        };
    }
    return null;
}

/** What a SillyTavern block would put into the prompt right now. */
function stPreviewText(node) {
    if (!liveCache) {
        const def = L.stPrompt(node.identifier);
        return def && !def.marker ? (def.content ?? '') : '';
    }
    try { return textOf(resolveNode(node, liveCache).messages); }
    catch { return ''; }
}

/* ================================================================== */
/* shell                                                              */
/* ================================================================== */

export function isOpen() {
    return !!root && root.classList.contains('pc-open');
}

export function open() {
    build();
    root.classList.add('pc-open');
    // Your SillyTavern theme may have changed since the last look, and the
    // light/dark adjustment depends on it.
    safe(() => applyTheme());
    const r = resolveGraph();
    current = r.graph ?? allGraphs()[0] ?? createGraph('Default');
    canvas.setGraph(current);
    renderAll();
    requestAnimationFrame(() => canvas.fit());
    refreshLive().then(() => { if (isOpen()) { canvas.render(); renderInspector(); } });
}

export function close() {
    root?.classList.remove('pc-open');
}

export function toggle() {
    isOpen() ? close() : open();
}

function mkBtn(icon, title, fn, cls = '') {
    const b = el('div', `pc-btn menu_button ${cls}`);
    b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
}

function build() {
    if (root) return;

    root = el('div', 'pc-root');

    const header = el('div', 'pc-header');
    const brand = el('div', 'pc-brand');
    brand.innerHTML = '<i class="fa-solid fa-diagram-project"></i><span>Silly Canvas</span>';

    const graphSelect = el('select', 'pc-select pc-graph-select text_pole');
    graphSelect.addEventListener('change', () => {
        const picked = getGraph(graphSelect.value);
        if (!picked) { renderGraphSelect(); return; }
        current = picked;
        // The canvas you are looking at is the canvas that runs. Anything else
        // is a trap: you arm it, nothing changes, and you have no idea why.
        settings().activeGraphId = current.id;
        save();
        canvas.setGraph(current);
        renderAll();
        canvas.fit();
    });

    const undoBtn = mkBtn('fa-rotate-left', 'Undo (Ctrl+Z)', () => doUndo(), 'pc-undo');
    const redoBtn = mkBtn('fa-rotate-right', 'Redo (Ctrl+Shift+Z)', () => doRedo(), 'pc-redo');
    const history = el('div', 'pc-header-actions pc-history');
    history.append(undoBtn, redoBtn, el('span', 'pc-history-note'));

    const headerButtons = el('div', 'pc-header-actions');
    headerButtons.append(
        mkBtn('fa-plus', 'New canvas', onNewGraph),
        mkBtn('fa-clone', 'Duplicate canvas', onDuplicateGraph),
        mkBtn('fa-i-cursor', 'Rename canvas', onRenameGraph),
        mkBtn('fa-trash-can', 'Delete canvas', onDeleteGraph),
        mkBtn('fa-file-import', 'Import canvas', onImportGraph),
        mkBtn('fa-file-export', 'Export canvas', onExportGraph),
        mkBtn('fa-wand-magic-sparkles', 'Seed from SillyTavern’s current prompt order', onSeedFromST),
        mkBtn('fa-expand', 'Fit to view', () => canvas.fit()),
        mkBtn('fa-palette', 'Theme and colours', toggleThemePopover, 'pc-theme-btn'),
    );

    const paneToggles = el('div', 'pc-header-actions');
    const sideBtn = mkBtn('fa-list-ul', 'Show or hide the library', () => togglePane('sidebar'), 'pc-pane-toggle');
    const inspBtn = mkBtn('fa-sliders', 'Show or hide the inspector', () => togglePane('inspector'), 'pc-pane-toggle');
    paneToggles.append(sideBtn, inspBtn);

    const armWrap = el('label', 'pc-arm');
    const arm = el('input', 'pc-arm-input');
    arm.type = 'checkbox';
    arm.addEventListener('change', () => {
        settings().enabled = arm.checked;
        save();
        renderStatus();
        toast(arm.checked
            ? 'Silly Canvas is armed. Your canvas now builds the prompt.'
            : 'Silly Canvas is off. SillyTavern builds the prompt as usual.',
        arm.checked ? 'success' : 'info');
    });
    armWrap.append(arm, el('span', '', 'Arm'));

    header.append(brand, graphSelect, history, headerButtons, paneToggles, armWrap, mkBtn('fa-xmark', 'Close', close, 'pc-close'));
    hookHistory();

    const status = el('div', 'pc-status');
    const body = el('div', 'pc-body');
    const sidebar = el('div', 'pc-sidebar');
    const stage = el('div', 'pc-stage');
    const canvasHost = el('div', 'pc-canvas-host');
    const inspector = el('div', 'pc-inspector');
    const preview = el('div', 'pc-preview');

    stage.append(canvasHost, preview);
    body.append(sidebar, stage, inspector);
    root.append(header, status, body);
    document.body.append(root);

    root._parts = { header, graphSelect, arm, status, sidebar, canvasHost, inspector, preview, sideBtn, inspBtn };

    // On a narrow window the side panes float over the canvas, so start with
    // them out of the way rather than covering the whole graph.
    if (window.innerWidth < 860) {
        root.classList.add('pc-hide-sidebar', 'pc-hide-inspector');
    }
    syncPaneToggles();

    document.addEventListener('pc-theme', () => { if (canvas && isOpen()) canvas.render(); });

    canvas = new Canvas(canvasHost, {
        onSelect: (item, kind) => { selected = item; selectedKind = kind; renderInspector(); },
        onChange: () => { renderStatus(); refreshPreview(); },
        onOpen: (node) => {
            selected = node; selectedKind = 'node';
            root.classList.remove('pc-hide-inspector');
            syncPaneToggles();
            renderInspector();
            inspector.classList.add('pc-flash');
            setTimeout(() => inspector.classList.remove('pc-flash'), 400);
        },
        onToast: (m) => toast(m, 'error'),
        onHelp: (node) => {
            guideOpen = true;
            root.classList.remove('pc-hide-inspector');
            syncPaneToggles();
            canvas.select({ kind: 'node', id: node.id });
        },
        onContextMenu: onCanvasMenu,
        onDrop: onCanvasDrop,
        onCreateAt: onCreateBlockAt,
        stPreview: stPreviewText,
        profileName,
        effectiveModel,
        waveInfo,
        copiesOf: (node) => (current ? (emissionCounts(current).get(node.id) ?? 1) : 1),
        onNodeOverFolder: highlightFolder,
        onDragBlock: showLibraryDropZone,
        onNodeDropOnFolder: saveNodeToFolder,
    });

    document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;
        const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        if (e.key === 'Escape' && !typing) { close(); return; }
        // In a text box, Ctrl+Z undoes your typing as usual; on the canvas it
        // undoes the last change to the canvas.
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !typing && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
            if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); return; }
        }
        if (mod && !typing && e.key.toLowerCase() === 'd' && selectedKind === 'node' && selected) {
            e.preventDefault();
            duplicateSelected(selected, e.shiftKey);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
            canvas.deleteSelection();
            renderAll();
        }
    });
}

function togglePane(which) {
    const cls = which === 'sidebar' ? 'pc-hide-sidebar' : 'pc-hide-inspector';
    root.classList.toggle(cls);
    syncPaneToggles();
    requestAnimationFrame(() => canvas.render());
}

function syncPaneToggles() {
    root._parts.sideBtn?.classList.toggle('pc-on', !root.classList.contains('pc-hide-sidebar'));
    root._parts.inspBtn?.classList.toggle('pc-on', !root.classList.contains('pc-hide-inspector'));
}

/** Mark the graph dirty and keep an open preview in step with the edit. */
function touch() {
    touchGraph(current);
    refreshPreview();
}

function renderAll() {
    H.track(current);
    paintHistory();
    renderGraphSelect();
    renderStatus();
    renderSidebar();
    renderInspector();
    canvas.render();
}

/** The theme editor, dropped down from the palette button. */
function toggleThemePopover() {
    const existing = root.querySelector('.pc-theme-pop');
    if (existing) { existing.remove(); return; }
    const pop = el('div', 'pc-theme-pop');
    const head = el('div', 'pc-theme-pop-head');
    head.append(el('b', '', 'Theme'), mkBtn('fa-xmark', 'Close', () => pop.remove(), 'pc-theme-pop-close'));
    const body = el('div');
    pop.append(head, body);
    root.append(pop);
    renderThemeEditor(body);
    const away = (e) => {
        if (!pop.isConnected) { document.removeEventListener('mousedown', away, true); return; }
        if (!pop.contains(e.target) && !e.target.closest('.pc-theme-btn')) { pop.remove(); document.removeEventListener('mousedown', away, true); }
    };
    document.addEventListener('mousedown', away, true);
}

/* ------------------------------------------------------------------ */
/* undo and redo                                                       */
/* ------------------------------------------------------------------ */

let historyHooked = false;

function hookHistory() {
    if (historyHooked) return;
    historyHooked = true;
    onGraphTouched((g) => H.noteChange(g));
    H.onHistoryChange((g) => { if (g === current) paintHistory(); });
}

function paintHistory() {
    const undoBtn = root?.querySelector('.pc-undo');
    const redoBtn = root?.querySelector('.pc-redo');
    if (!undoBtn || !current) return;
    const next = H.peek(current);
    undoBtn.classList.toggle('pc-disabled', !next.undo);
    redoBtn.classList.toggle('pc-disabled', !next.redo);
    undoBtn.title = next.undo ? `Undo: ${next.undo} (Ctrl+Z)` : 'Nothing to undo';
    redoBtn.title = next.redo ? `Redo: ${next.redo} (Ctrl+Shift+Z)` : 'Nothing to redo';
}

/** After undo or redo the canvas objects are new, so find the selection again by id. */
function afterHistory(label, verb) {
    if (!label) { paintHistory(); return; }
    current.updatedAt = Date.now();
    save();
    if (selectedKind === 'node' && selected) selected = current.nodes[selected.id] ?? null;
    if (selectedKind === 'wire' && selected) selected = current.wires[selected.id] ?? null;
    if (!selected) selectedKind = null;
    canvas.select(selected ? { kind: selectedKind, id: selected.id } : null);
    renderAll();
    refreshPreview();
    flashHistoryNote(`${verb} ${label}`);
}

/** A quiet note beside the undo buttons that fades on its own. */
let noteTimer = null;
function flashHistoryNote(text) {
    const note = root?.querySelector('.pc-history-note');
    if (!note) return;
    note.textContent = text;
    note.classList.add('pc-show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.classList.remove('pc-show'), 1600);
}

function doUndo() { if (current) afterHistory(H.undo(current), 'Undid'); }
function doRedo() { if (current) afterHistory(H.redo(current), 'Redid'); }

function renderGraphSelect() {
    const sel = root._parts.graphSelect;
    sel.innerHTML = '';
    for (const g of allGraphs()) {
        const o = el('option', '', g.name);
        o.value = g.id;
        sel.append(o);
    }
    if (current) sel.value = current.id;
    root._parts.arm.checked = !!settings().enabled;
}

function renderStatus() {
    safe(() => document.dispatchEvent(new CustomEvent('pc-state')));
    const s = root._parts.status;
    const r = resolveGraph();
    const armed = !!settings().enabled;
    const c = ctx();
    const charName = safe(() => c.characters?.[c.characterId]?.name) ?? null;

    s.innerHTML = '';
    s.append(el('span', `pc-pill ${armed ? 'pc-pill-on' : 'pc-pill-off'}`, armed ? 'Armed' : 'Off'));

    const overridden = armed && r.graph && current && r.graph.id !== current.id;

    const which = el('span', overridden ? 'pc-status-text pc-status-warn' : 'pc-status-text');
    which.textContent = !armed
        ? 'SillyTavern builds the prompt as usual.'
        : !r.graph
            ? 'No canvas resolves — SillyTavern will build the prompt.'
            : overridden
                ? `"${r.graph.name}" runs, not the canvas you have open — it is pinned to this ${r.source}.`
                : `Sending through "${r.graph.name}" (${r.source === 'chat' ? 'pinned to this chat' : r.source === 'character' ? 'pinned to this character' : 'default canvas'})`;
    s.append(which);

    if (overridden) {
        const fix = el('div', 'pc-btn menu_button pc-primary');
        fix.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Run this one instead';
        fix.title = `Unpin and run "${current.name}"`;
        fix.addEventListener('click', async () => {
            if (r.source === 'chat') setChatBinding(null);
            if (r.source === 'character') await setCharacterBinding(null);
            settings().activeGraphId = current.id;
            save();
            renderStatus();
        });
        s.append(fix);
    }

    s.append(el('span', 'pc-spacer'));

    const chatPinned = chatBinding() === current?.id;
    const bindChat = el('div', 'pc-btn menu_button');
    bindChat.innerHTML = `<i class="fa-solid fa-thumbtack"></i> ${chatPinned ? 'Unpin from chat' : 'Pin to this chat'}`;
    bindChat.addEventListener('click', () => {
        if (!setChatBinding(chatPinned ? null : current.id)) return toast('No chat is open.', 'error');
        renderStatus();
    });

    const charPinned = characterBinding() === current?.id;
    const bindChar = el('div', 'pc-btn menu_button');
    bindChar.innerHTML = `<i class="fa-solid fa-user-pen"></i> ${charPinned ? 'Unpin from character' : 'Pin to character'}`;
    bindChar.title = charName ? `Travels with ${charName}’s card` : 'No character selected';
    bindChar.addEventListener('click', async () => {
        if (!await setCharacterBinding(charPinned ? null : current.id)) return toast('No character selected.', 'error');
        renderStatus();
    });

    const isDefault = settings().activeGraphId === current?.id;
    const setDefault = el('div', 'pc-btn menu_button');
    setDefault.innerHTML = `<i class="fa-solid fa-star"></i> ${isDefault ? 'Default canvas' : 'Make default'}`;
    setDefault.addEventListener('click', () => { settings().activeGraphId = current.id; save(); renderStatus(); });


    const previewBtn = el('div', 'pc-btn menu_button pc-primary');
    previewBtn.innerHTML = '<i class="fa-solid fa-eye"></i> Preview prompt';
    previewBtn.addEventListener('click', runPreview);

    s.append(bindChat, bindChar, setDefault, previewBtn);
}

/* ================================================================== */
/* sidebar: the library                                               */
/* ================================================================== */

function renderSidebar() {
    const sb = root._parts.sidebar;
    sb.innerHTML = '';

    const head = el('div', 'pc-side-head');
    head.append(el('span', 'pc-side-title', 'Library'));

    const addFolder = mkBtn('fa-folder-plus', 'New folder', async () => {
        const name = await inputBox('Name for the new folder');
        if (name) { L.createFolder(name); renderSidebar(); }
    });
    const addPrompt = mkBtn('fa-plus', 'New prompt', async () => {
        const name = await inputBox('Name for the new prompt');
        if (name) { L.createPrompt({ name }); renderSidebar(); }
    });
    head.append(addFolder, addPrompt);

    const search = el('input', 'pc-search text_pole');
    search.type = 'search';
    search.placeholder = 'Search prompts';

    const list = el('div', 'pc-side-list');
    search.addEventListener('input', () => renderLists(list, search.value));

    sb.append(head, search, list);
    renderLists(list, '');

    const blocks = el('div', 'pc-side-blocks');
    blocks.append(el('div', 'pc-side-title', 'Blocks'));
    const grid = el('div', 'pc-block-grid');
    for (const [type, icon, label] of [
        [NODE_TYPES.PROMPT, 'fa-comment', 'Prompt'],
        [NODE_TYPES.GENERATE, 'fa-brain', 'Generate'],
        [NODE_TYPES.DECIDER, 'fa-code-fork', 'Decider'],
        [NODE_TYPES.HISTORY, 'fa-clock-rotate-left', 'History'],
        [NODE_TYPES.INJECTION, 'fa-syringe', 'Injection'],
        [NODE_TYPES.LOREBOOK, 'fa-book-atlas', 'Lorebook'],
        [NODE_TYPES.NOTE, 'fa-note-sticky', 'Note'],
    ]) {
        const b = el('div', 'pc-block-chip');
        b.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
        b.draggable = true;
        b.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-prompt-canvas', JSON.stringify({ kind: 'block', type }));
        });
        b.title = `Drag ${label} onto the canvas`;
        // Placing a block is a drag. A click that dumps one at a fixed spot
        // puts blocks where you were not looking.
        b.addEventListener('click', () => toast(`Drag "${label}" onto the canvas to place it.`));
        grid.append(b);
    }
    blocks.append(grid);
    sb.append(blocks);
}

function renderLists(container, query) {
    container.innerHTML = '';

    const q = String(query || '').toLowerCase();

    /* SillyTavern's own prompts ---------------------------------- */
    const stList = L.stPrompts().filter(p => !q || p.name.toLowerCase().includes(q));
    const stFolder = makeFolder('SillyTavern', stList.length, true, null, '__sillytavern__');
    for (const p of stList) {
        const item = el('div', `pc-lib-item pc-lib-st${p.enabled ? '' : ' pc-lib-dim'}`);
        item.innerHTML = `<i class="fa-solid ${p.marker ? 'fa-cube' : 'fa-align-left'}"></i>` +
            `<span class="pc-lib-name">${escapeHtml(p.name)}</span>` +
            `<span class="pc-lib-tag">${p.marker ? 'dynamic' : escapeHtml(p.role ?? 'system')}</span>`;
        item.title = p.marker
            ? `${p.identifier} — assembled by SillyTavern at send time`
            : (p.content || '(empty)').slice(0, 400);
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-prompt-canvas', JSON.stringify({ kind: 'st', identifier: p.identifier, name: p.name }));
        });
        item.title += '\n\nDrag onto the canvas to use.';
        stFolder.body.append(item);
    }
    container.append(stFolder.wrap);

    /* user folders ------------------------------------------------ */
    const pool = q ? L.searchLibrary(q) : L.prompts();
    for (const f of L.folders()) {
        const items = pool.filter(p => p.folderId === f.id);
        if (q && !items.length) continue;
        const folder = makeFolder(f.name, items.length, false, f, f.id);
        for (const p of items) {
            const item = el('div', 'pc-lib-item');
            item.innerHTML = '<i class="fa-solid fa-align-left"></i>' +
                `<span class="pc-lib-name">${escapeHtml(p.name)}</span>` +
                `<span class="pc-lib-tag">${escapeHtml(p.role)}</span>`;
            item.title = (p.content || '(empty)').slice(0, 400);
            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-prompt-canvas', JSON.stringify({ kind: 'library', id: p.id }));
            });
            item.title = 'Click to edit \u00b7 drag onto the canvas to use';
            item.addEventListener('click', (e) => {
                if (e.target.closest('.pc-lib-del')) return;
                canvas.select(null);
                selected = p;
                selectedKind = 'library';
                root.classList.remove('pc-hide-inspector');
                syncPaneToggles();
                renderInspector();
                for (const n of container.querySelectorAll('.pc-lib-active')) n.classList.remove('pc-lib-active');
                item.classList.add('pc-lib-active');
            });

            const del = el('i', 'fa-solid fa-xmark pc-lib-del');
            del.title = 'Delete prompt';
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (await confirmBox(`Delete "${p.name}" from the library?`)) { L.deletePrompt(p.id); renderSidebar(); }
            });
            item.append(del);
            folder.body.append(item);
        }
        container.append(folder.wrap);
    }
}

function makeFolder(name, count, builtin, folderRef = null, key = null) {
    const wrap = el('div', 'pc-folder');
    const folderKey = key ?? folderRef?.id ?? name;
    wrap.dataset.folder = folderRef?.id ?? '';
    if (isFolderCollapsed(folderKey)) wrap.classList.add('pc-collapsed');
    const head = el('div', 'pc-folder-head');
    head.innerHTML = '<i class="fa-solid fa-chevron-down pc-folder-arrow"></i>' +
        `<i class="fa-solid ${builtin ? 'fa-box-archive' : 'fa-folder'}"></i>` +
        `<span>${escapeHtml(name)}</span><span class="pc-folder-count">${count}</span>`;
    const body = el('div', 'pc-folder-body');
    head.addEventListener('click', () => {
        const collapsed = wrap.classList.toggle('pc-collapsed');
        setFolderCollapsed(folderKey, collapsed);
    });

    if (folderRef) {
        const ren = el('i', 'fa-solid fa-pen pc-folder-act');
        ren.title = 'Rename folder';
        ren.addEventListener('click', async (e) => {
            e.stopPropagation();
            const n = await inputBox('Rename folder', folderRef.name);
            if (n) { L.renameFolder(folderRef.id, n); renderSidebar(); }
        });
        const del = el('i', 'fa-solid fa-trash-can pc-folder-act');
        del.title = 'Delete folder (prompts are kept)';
        del.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (await confirmBox(`Delete folder "${folderRef.name}"? Its prompts move to the first folder.`)) {
                if (!L.deleteFolder(folderRef.id)) toast('You need at least one folder.', 'error');
                renderSidebar();
            }
        });
        head.append(ren, del);
    }
    wrap.append(head, body);
    return { wrap, body };
}

/* ================================================================== */
/* drops                                                              */
/* ================================================================== */

function onCanvasDrop(payload, at) {
    if (!current) return;
    if (payload.kind === 'block') {
        const n = addNode(current, payload.type, Math.round(at.x), Math.round(at.y));
        canvas.select({ kind: 'node', id: n.id });
        renderAll();
    } else if (payload.kind === 'st') {
        dropST({ identifier: payload.identifier, name: payload.name }, at);
    } else if (payload.kind === 'library') {
        dropLibrary(payload.id, at);
    }
}

function dropST(p, at) {
    const n = addNode(current, NODE_TYPES.ST, Math.round(at.x), Math.round(at.y));
    n.identifier = p.identifier;
    n.title = p.name;
    autoWire(n);
    canvas.select({ kind: 'node', id: n.id });
    renderAll();
}

function dropLibrary(id, at) {
    const p = L.getPrompt(id);
    if (!p) return;
    const n = addNode(current, NODE_TYPES.PROMPT, Math.round(at.x), Math.round(at.y));
    n.title = p.name;
    n.role = p.role;
    n.content = p.content;
    n.libraryId = p.id;
    autoWire(n);
    canvas.select({ kind: 'node', id: n.id });
    renderAll();
}

/**
 * Double-clicking empty canvas makes a prompt block right there, ready to type
 * into. Nothing is saved anywhere until you decide to save it.
 */
function onCreateBlockAt(at) {
    if (!current) return;
    const n = addNode(current, NODE_TYPES.PROMPT, Math.round(at.x) - 130, Math.round(at.y) - 40);
    n.title = 'New prompt';
    autoWire(n);
    root.classList.remove('pc-hide-inspector');
    syncPaneToggles();
    canvas.select({ kind: 'node', id: n.id });
    renderAll();
    const ta = root._parts.inspector.querySelector('textarea');
    ta?.focus();
}

function highlightFolder(target) {
    for (const f of root.querySelectorAll('.pc-folder-target')) f.classList.remove('pc-folder-target');
    const side = root.querySelector('.pc-sidebar');
    side?.classList.toggle('pc-drop-ready', !!target);
    if (!target) return;
    // Anywhere on the library that is not a folder files it in the first one.
    const folder = target.dataset?.folder
        ? target
        : root.querySelector(`.pc-folder[data-folder="${CSS.escape(L.folders()[0]?.id ?? '')}"]`);
    folder?.classList.add('pc-folder-target');
    const name = folder?.querySelector('.pc-folder-head span')?.textContent ?? 'the library';
    if (side) side.dataset.dropHint = `Drop to save to \u201c${name}\u201d`;
}

/** While a block is dragged, the library says it can take it. */
export function showLibraryDropZone(on) {
    root?.querySelector('.pc-sidebar')?.classList.toggle('pc-drop-zone', !!on);
}

/**
 * Dropping a block onto a library folder saves it there. The block itself goes
 * back where it was: you are filing a copy, not moving the block off the canvas.
 */
function saveNodeToFolder(node, folderId) {
    folderId = folderId || L.folders()[0]?.id || null;
    if (node.type !== NODE_TYPES.PROMPT && node.type !== NODE_TYPES.ST && node.type !== NODE_TYPES.GENERATE) {
        toast(`Only prompt text can be saved to the library; "${node.title}" is a ${node.type} block.`, 'warning');
        return;
    }
    const content = node.type === NODE_TYPES.ST
        ? (node.override?.content ?? L.stPrompt(node.identifier)?.content ?? '')
        : (node.content ?? '');
    const role = node.type === NODE_TYPES.ST
        ? (node.override?.role ?? L.stPrompt(node.identifier)?.role ?? 'system')
        : (node.role ?? 'system');

    if (!String(content).trim()) {
        toast(`"${node.title}" has no text to save.`, 'error');
        return;
    }

    if (node.libraryId && L.getPrompt(node.libraryId)) {
        L.updatePrompt(node.libraryId, { name: node.title, role, content, folderId });
        toast(`Updated "${node.title}" in the library.`, 'success');
    } else {
        const p = L.createPrompt({ name: node.title, role, content, folderId });
        node.libraryId = p.id;
        touch();
        toast(`Saved "${node.title}" to the library.`, 'success');
    }
    renderSidebar();
}

/** A freshly dropped block with nothing attached goes straight to Output. */
function autoWire(node) {
    const out = outputNode(current);
    if (out && out.id !== node.id) connect(current, node.id, out.id, WIRE_KINDS.MERGE);
}

/* ================================================================== */
/* inspector                                                          */
/* ================================================================== */

function field(label, control, hint) {
    const w = el('div', 'pc-field');
    w.append(el('label', 'pc-label', label), control);
    if (hint) w.append(el('div', 'pc-hint', hint));
    return w;
}

function checkline(labelText, checked, onChange) {
    const line = el('label', 'pc-checkline');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    line.append(cb, el('span', '', labelText));
    return line;
}

function dropdown(pairs, value, onChange) {
    const sel = el('select', 'pc-select text_pole');
    for (const [v, label] of pairs) {
        const o = el('option', '', label);
        o.value = v;
        sel.append(o);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

function renderInspector() {
    const box = root._parts.inspector;
    box.innerHTML = '';

    if (!selected) {
        box.append(el('div', 'pc-empty', 'Select a block or a wire.'));
        const help = el('div', 'pc-help');
        help.innerHTML =
            '<p><b>Adding a block</b> — drag one in from the Blocks panel below the library, or double-click empty canvas for a prompt.</p>' +
            '<p><b>Wiring</b> — drag from the dot on a block’s bottom edge onto another block. Double-click a wire to cycle what it does.</p>' +
            '<p><b>Order</b> — blocks are read top to bottom. Move a block higher and it enters the prompt earlier.</p>' +
            '<p><b>merge</b> keeps the upstream block as its own message.<br>' +
            '<b>append</b> and <b>prepend</b> fold its text into the block it points at.</p>' +
            '<p><b>Sending two at once</b> \u2014 drag the \u26a1 dot on a Generate block\u2019s right edge onto another Generate block. Nothing flows along that tie; it only says the two go out together and both replies are waited for.</p>' +
            '<p><b>Generate</b> is a send point. What is wired into its top goes to the model; the reply goes to whatever is wired to its bottom. The blocks feeding it stay on its side of the wall.</p>';
        box.append(help);
        return;
    }

    if (selectedKind === 'wire') return renderWireInspector(box);
    if (selectedKind === 'library') return renderLibraryInspector(box);
    return renderNodeInspector(box);
}

/** Edit a saved prompt where it lives, without putting it on the canvas. */
function renderLibraryInspector(box) {
    const p = L.getPrompt(selected.id);
    if (!p) { selected = null; selectedKind = null; return renderInspector(); }

    box.append(el('div', 'pc-insp-title', 'Library prompt'));

    const name = el('input', 'text_pole');
    name.value = p.name;
    name.addEventListener('input', () => { L.updatePrompt(p.id, { name: name.value }); renderSidebar(); });
    box.append(field('Name', name));

    box.append(field('Folder', dropdown(L.folders().map(f => [f.id, f.name]), p.folderId, (v) => {
        L.updatePrompt(p.id, { folderId: v });
        renderSidebar();
    })));

    box.append(field('Role', dropdown(ROLES.map(r => [r, r]), p.role || 'system', (v) => {
        L.updatePrompt(p.id, { role: v });
        renderSidebar();
    })));

    const content = el('textarea', 'text_pole pc-textarea');
    content.rows = 16;
    content.value = p.content ?? '';
    content.addEventListener('input', () => { L.updatePrompt(p.id, { content: content.value }); });
    box.append(field('Text', content, 'Saved as you type. Drag the prompt onto the canvas to use it.'));

    const del = el('div', 'pc-btn menu_button pc-danger');
    del.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete from library';
    del.addEventListener('click', async () => {
        if (!await confirmBox(`Delete "${p.name}" from the library?`)) return;
        L.deletePrompt(p.id);
        selected = null; selectedKind = null;
        renderSidebar(); renderInspector();
    });
    box.append(del);
}

function renderWireInspector(box) {
    const wire = selected;
    const from = current.nodes[wire.from];
    const to = current.nodes[wire.to];

    if (wire.kind === WIRE_KINDS.TOGETHER) {
        box.append(el('div', 'pc-insp-title', 'Sent together'));
        box.append(el('div', 'pc-hint', `${from?.title ?? '?'} and ${to?.title ?? '?'}`));
        box.append(el('div', 'pc-hint',
            'These two go out at the same time and both replies are waited for. Nothing travels along this tie — it only decides when they leave.'));

        const cut = el('div', 'pc-btn menu_button pc-danger');
        cut.innerHTML = '<i class="fa-solid fa-scissors"></i> Untie them';
        cut.addEventListener('click', () => {
            disconnect(current, wire.id);
            selected = null;
            canvas.render();
            renderInspector();
        });
        box.append(cut);
        return;
    }

    if (wire.loop) return renderLoopInspector(box, wire, from, to);

    box.append(el('div', 'pc-insp-title', 'Wire'));
    box.append(el('div', 'pc-hint', `${from?.title ?? '?'} → ${to?.title ?? '?'}`));

    const explain = {
        [WIRE_KINDS.MERGE]: 'The upstream block stays its own message, placed just before this one.',
        [WIRE_KINDS.APPEND]: 'The upstream text is glued onto the end of this block’s text.',
        [WIRE_KINDS.PREPEND]: 'The upstream text is glued onto the front of this block’s text.',
    };

    // What travels along it: the text, nothing (it only switches the block
    // on), or a Decider's decision.
    const fromDecider = from?.type === NODE_TYPES.DECIDER;
    const fromLore = from?.type === NODE_TYPES.LOREBOOK;
    const mode = wire.mode === 'activate' || (wire.mode === 'result' && (fromDecider || fromLore)) ? wire.mode : 'send';
    const modes = [['send', 'Send the text'], ['activate', 'Only switch it on (Activate)']];
    if (fromDecider) modes.push(['result', 'Send the decision (Forward result)']);
    if (fromLore) modes.push(['result', 'Send the names of the entries that fired (Forward result)']);
    const modeExplain = {
        send: 'The text travels along the wire, as always.',
        activate: `Nothing travels. "${to?.title ?? 'The block'}" only runs when at least one of its Activate wires fires, and then uses its own content.${fromDecider ? ' This one fires when this output is chosen.' : ` This one fires when "${from?.title ?? 'the block'}" is on.`}`,
        result: fromLore
            ? `Sends the titles of the entries this Lorebook sent, e.g. "Weapons, Tavern". Wire it into a Decider to route on which lore fired, or put {{result}} in "${to?.title ?? 'the block'}"\u2019s text.`
            : `Sends what the Decider decided, as a short piece of text. Put {{result}} in "${to?.title ?? 'the block'}"\u2019s text to choose where it goes; otherwise it is added like any wired text.`,
    };
    box.append(field('What travels', dropdown(modes, mode, (v) => {
        if (v === 'send') delete wire.mode; else wire.mode = v;
        touch(); canvas.render(); renderInspector();
    }), modeExplain[mode]));

    if (mode === 'result' && fromDecider) {
        box.append(field('Which result', dropdown([['name', 'The name of the chosen output'], ['matched', 'The words that matched']], wire.result === 'matched' ? 'matched' : 'name', (v) => {
            if (v === 'name') delete wire.result; else wire.result = v;
            touch(); canvas.render();
        }), 'The matched words come from word rules; when there are none, the output\u2019s name is sent.'));
    }

    if (mode !== 'activate') {
        const sel = dropdown(Object.entries(WIRE_LABEL), wire.kind, (v) => {
            canvas.setWireKind(wire.id, v);
            renderInspector();
        });
        box.append(field('How it joins', sel, explain[wire.kind]));
    }

    if (mode === 'send') renderSelectFields(box, wire);

    // Two Generate blocks can be tied instead of wired: that drops the text
    // flow between them and simply sends them at the same time.
    if (from?.type === NODE_TYPES.GENERATE && to?.type === NODE_TYPES.GENERATE) {
        const tie = el('div', 'pc-btn menu_button');
        tie.innerHTML = '<i class="fa-solid fa-bolt"></i> Send these two together instead';
        tie.title = 'Drops the text flow between them and sends them at the same time';
        tie.addEventListener('click', () => {
            const kind = wire.kind;
            disconnect(current, wire.id);
            const res = connect(current, wire.from, wire.to, WIRE_KINDS.TOGETHER);
            if (!res.ok) {
                connect(current, wire.from, wire.to, kind);
                canvas.render();
                return toast(res.reason, 'error');
            }
            selected = res.wire;
            canvas.render();
            renderInspector();
        });
        box.append(tie);
    }

    const del = el('div', 'pc-btn menu_button pc-danger');
    del.innerHTML = '<i class="fa-solid fa-scissors"></i> Cut this wire';
    del.addEventListener('click', () => {
        disconnect(current, wire.id);
        selected = null;
        canvas.render();
        renderInspector();
    });
    box.append(del);
}

function renderNodeInspector(box) {
    const node = selected;
    box.append(el('div', 'pc-insp-title', TYPE_LABEL[node.type] ?? node.type));

    const title = el('input', 'text_pole');
    title.value = node.title ?? '';
    title.addEventListener('input', () => { node.title = title.value; touch(); canvas.render(); });
    box.append(field('Name', title));

    if (node.type !== NODE_TYPES.OUTPUT) {
        box.append(checkline('Switched on', node.enabled !== false, (v) => {
            node.enabled = v; touch(); canvas.render();
        }));
    }

    if (node.type === NODE_TYPES.PROMPT) renderPromptFields(box, node);
    else if (node.type === NODE_TYPES.ST) renderStFields(box, node);
    else if (node.type === NODE_TYPES.HISTORY) renderHistoryFields(box, node);
    else if (node.type === NODE_TYPES.INJECTION) renderInjectionFields(box, node);
    else if (node.type === NODE_TYPES.LOREBOOK) renderLoreFields(box, node);
    else if (node.type === NODE_TYPES.GENERATE) renderGenerateFields(box, node);
    else if (node.type === NODE_TYPES.DECIDER) renderDeciderFields(box, node);
    else if (node.type === NODE_TYPES.NOTE) {
        const ta = el('textarea', 'text_pole pc-textarea');
        ta.rows = 8;
        ta.value = node.content ?? '';
        ta.addEventListener('input', () => { node.content = ta.value; touch(); canvas.render(); });
        box.append(field('Note', ta, 'For you. Never sent.'));
    } else if (node.type === NODE_TYPES.OUTPUT) {
        box.append(el('div', 'pc-hint', 'Everything wired into this block is sent, in the order the blocks sit on the canvas.'));
    }

    if (node.type !== NODE_TYPES.NOTE && node.type !== NODE_TYPES.DECIDER) {
        box.append(el('hr', 'pc-rule'));
        renderConditionEditor(box, node);
        renderModelEditor(box, node);
    }

    if (node.type !== NODE_TYPES.OUTPUT) {
        const dup = el('div', 'pc-btn menu_button');
        dup.innerHTML = '<i class="fa-solid fa-clone"></i> Duplicate';
        dup.title = 'A copy without its wires (Ctrl+D). Ctrl+Shift+D also copies the wires coming in.';
        dup.addEventListener('click', () => duplicateSelected(node, false));
        const actions = el('div', 'pc-row pc-insp-actions');
        actions.append(dup);
        box.append(actions);
        const del = el('div', 'pc-btn menu_button pc-danger');
        del.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete this block';
        del.addEventListener('click', () => {
            removeNode(current, node.id);
            selected = null;
            canvas.render();
            renderInspector();
        });
        actions.append(del);
    }
}

function renderPromptFields(box, node) {
    box.append(field('Role', dropdown(ROLES.map(r => [r, r]), node.role || 'system', (v) => {
        node.role = v; touch(); canvas.render();
    })));

    const content = el('textarea', 'text_pole pc-textarea');
    content.rows = 12;
    content.value = node.content ?? '';
    content.addEventListener('input', () => { node.content = content.value; touch(); canvas.render(); });
    box.append(field('Text', content, 'SillyTavern macros work here: {{char}}, {{user}}, {{persona}} and the rest.'));

    const saveToLib = el('div', 'pc-btn menu_button');
    saveToLib.innerHTML = '<i class="fa-solid fa-bookmark"></i> Save to library';
    saveToLib.addEventListener('click', () => {
        if (node.libraryId && L.getPrompt(node.libraryId)) {
            L.updatePrompt(node.libraryId, { name: node.title, role: node.role, content: node.content });
            toast('Library prompt updated.', 'success');
        } else {
            const p = L.createPrompt({ name: node.title, role: node.role, content: node.content });
            node.libraryId = p.id;
            touch();
            toast('Saved to library.', 'success');
        }
        renderSidebar();
    });
    box.append(saveToLib);
}

function renderStFields(box, node) {
    const pairs = [['', '— choose a SillyTavern prompt —']];
    for (const p of L.stPrompts()) {
        pairs.push([p.identifier, `${p.name}${p.marker ? ' (dynamic)' : ''}${p.enabled ? '' : ' — off in Prompt Manager'}`]);
    }
    box.append(field('SillyTavern prompt', dropdown(pairs, node.identifier ?? '', (v) => {
        node.identifier = v;
        const def = L.stPrompt(v);
        if (def) node.title = def.name;
        node.override = null;
        touch(); canvas.render(); renderInspector();
    })));

    const def = L.stPrompt(node.identifier);
    if (!def) return;

    const edited = node.override?.content !== undefined;
    const role = edited ? (node.override.role || 'system') : (def.role || 'system');

    if (edited) {
        const badge = el('div', 'pc-edited');
        badge.innerHTML = '<i class="fa-solid fa-pen"></i> Edited on this canvas. Your preset still has the original.';
        box.append(badge);
    } else if (def.marker) {
        box.append(el('div', 'pc-hint',
            'SillyTavern assembles this one at send time. What you see below is what it holds right now — type in it to pin your own text instead.'));
    }

    box.append(field('Role', dropdown(ROLES.map(r => [r, r]), role, (v) => {
        ensureOverride(node, def);
        node.override.role = v;
        touch(); canvas.render(); renderInspector();
    })));

    const live = edited ? node.override.content : (def.marker ? stPreviewText(node) : (def.content ?? ''));
    const ta = el('textarea', 'text_pole pc-textarea');
    ta.rows = 14;
    ta.value = live;
    ta.spellcheck = false;

    // The first keystroke turns a view into an edit. Nothing is written to the
    // preset until you ask for that explicitly, so experimenting here can never
    // cost you the prompt you started with.
    ta.addEventListener('input', () => {
        ensureOverride(node, def);
        node.override.content = ta.value;
        touch();
        canvas.render();
        if (!box.querySelector('.pc-edited')) renderInspector();
    });
    if (!edited && def.marker && !live) {
        ta.placeholder = 'Nothing in it right now. Open a chat with a character, or type here to pin your own text.';
    }
    box.append(field(edited ? 'Text (yours)' : def.marker ? 'What it holds right now' : 'Text (from your preset)', ta));

    if (!edited && def.marker) {
        const refresh = el('div', 'pc-btn menu_button');
        refresh.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
        refresh.title = 'Re-read world info, character fields and injections';
        refresh.addEventListener('click', async () => {
            refresh.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading';
            await refreshLive();
            renderInspector();
            canvas.render();
        });
        box.append(refresh);
    }

    if (edited) {
        const row = el('div', 'pc-btn-row');

        const revert = el('div', 'pc-btn menu_button');
        revert.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Revert to preset';
        revert.addEventListener('click', () => {
            node.override = null;
            touch(); canvas.render(); renderInspector();
        });
        row.append(revert);

        if (!def.marker) {
            const push = el('div', 'pc-btn menu_button');
            push.innerHTML = '<i class="fa-solid fa-upload"></i> Write back to preset';
            push.title = 'Change the prompt in SillyTavern itself, for every chat';
            push.addEventListener('click', () => writeBackToPreset(node, def));
            row.append(push);
        }
        box.append(row);
    }
}

function ensureOverride(node, def) {
    if (node.override?.content === undefined) {
        node.override = {
            content: def.marker ? stPreviewText(node) : (def.content ?? ''),
            role: def.role || 'system',
        };
    }
}

/**
 * Push a canvas edit into SillyTavern's own prompt list. This leaves the
 * canvas and changes the preset for every chat, so it asks first.
 */
async function writeBackToPreset(node, def) {
    const text = node.override?.content ?? '';
    if (!await confirmBox(
        `Replace "${def.name}" in your SillyTavern preset with this text? Every chat using this preset is affected, and the canvas override is cleared.`)) return;

    const prompts = safe(() => ctx().chatCompletionSettings?.prompts);
    const target = prompts?.find(p => p.identifier === node.identifier);
    if (!target) return toast('That prompt is no longer in the preset.', 'error');

    target.content = text;
    if (node.override.role) target.role = node.override.role;
    node.override = null;
    touch();
    save();
    safe(() => ctx().saveSettingsDebounced());
    canvas.render();
    renderInspector();
    renderSidebar();
    toast(`"${def.name}" updated in your preset. Save the preset in SillyTavern to keep it.`, 'success');
}

function renderHistoryFields(box, node) {
    const count = el('input', 'text_pole');
    count.type = 'number'; count.min = '0';
    count.value = node.count ?? 0;
    count.addEventListener('input', () => { node.count = Number(count.value) || 0; touch(); canvas.render(); });
    box.append(field('How many messages', count, '0 means the whole chat.'));

    const skip = el('input', 'text_pole');
    skip.type = 'number'; skip.min = '0';
    skip.value = node.skip ?? 0;
    skip.addEventListener('input', () => { node.skip = Number(skip.value) || 0; touch(); canvas.render(); });
    box.append(field('Skip the most recent', skip, 'Useful when another block handles the latest turn.'));

    box.append(field('Shape', dropdown([
        ['turns', 'Turns \u2014 one message each'],
        ['prose', 'Prose \u2014 one block of paragraphs'],
    ], node.format ?? 'turns', (v) => { node.format = v; touch(); canvas.render(); renderInspector(); }),
    node.format === 'prose'
        ? 'The turn structure is dissolved: no roles, no ping-pong. A model handed narrative continues narrative.'
        : 'Normal user/assistant alternation, the way SillyTavern sends it.'));

    if (node.format !== 'prose') return;

    box.append(field('Speaker labels', dropdown([
        ['none', 'None \u2014 pure narrative'],
        ['inline', 'Name: text'],
        ['attribution', 'Name \u2014 text'],
    ], node.nameStyle ?? 'none', (v) => { node.nameStyle = v; touch(); canvas.render(); })));

    box.append(field('Send as', dropdown(ROLES.map(r => [r, r]), node.proseRole || 'system', (v) => {
        node.proseRole = v; touch(); canvas.render();
    })));

    box.append(checkline('Run consecutive messages from one speaker together', node.collapseSpeakers !== false, (v) => {
        node.collapseSpeakers = v; touch(); canvas.render();
    }));

    box.append(checkline('Strip *action asterisks*', node.stripAsterisks, (v) => {
        node.stripAsterisks = v; touch(); canvas.render();
    }));

    const prefix = el('textarea', 'text_pole pc-textarea');
    prefix.rows = 3;
    prefix.value = node.prefix ?? '';
    prefix.placeholder = 'The story so far:';
    prefix.addEventListener('input', () => { node.prefix = prefix.value; touch(); canvas.render(); });
    box.append(field('Before the story', prefix, 'Framing text placed above the prose. Macros work here.'));

    const suffix = el('textarea', 'text_pole pc-textarea');
    suffix.rows = 3;
    suffix.value = node.suffix ?? '';
    suffix.placeholder = 'Continue the story from here.';
    suffix.addEventListener('input', () => { node.suffix = suffix.value; touch(); canvas.render(); });
    box.append(field('After the story', suffix));
}

function renderGenerateFields(box, node) {
    box.append(el('div', 'pc-hint',
        'A send point. Whatever is wired into the top goes to the model, and its reply goes to whatever is wired to the bottom.'));

    const tied = tiedTo(node);
    if (tied.length) {
        const bolt = el('div', 'pc-tied');
        bolt.innerHTML = `<i class="fa-solid fa-bolt"></i> Sent at the same time as ${tied.map(escapeHtml).join(', ')}.`;
        box.append(bolt);
    } else if (Object.values(current.nodes).filter(n => n.type === NODE_TYPES.GENERATE).length > 1) {
        box.append(el('div', 'pc-hint',
            'To send this at the same time as another Generate block, drag the \u26a1 dot on its right edge onto that block.'));
    }

    const row = el('div', 'pc-btn-row');

    // Free: exactly what would be sent, nothing spent.
    const peek = el('div', 'pc-btn menu_button');
    peek.innerHTML = '<i class="fa-solid fa-eye"></i> Preview what this sends';
    peek.addEventListener('click', () => showBlockPreview(node, box));
    row.append(peek);

    // One request, the real reply or the real error, without spending a turn
    // of the chat to find out which.
    const test = el('div', 'pc-btn menu_button pc-primary');
    test.innerHTML = '<i class="fa-solid fa-vial"></i> Test';
    test.addEventListener('click', () => runBlockTest(node, test, box));
    row.append(test);

    box.append(row);
    box.append(el('div', 'pc-test-slot'));

    const content = el('textarea', 'text_pole pc-textarea');
    content.rows = 6;
    content.value = node.content ?? '';
    content.placeholder = 'What should the model do with what is wired in? For example: List three beats for the next scene.';
    const where = el('div', 'pc-hint');
    const explain = () => { where.textContent = instructionHint(node); };
    content.addEventListener('input', () => { node.content = content.value; touch(); canvas.render(); explain(); });
    explain();
    const f = field('Instruction', content);
    f.append(where);
    box.append(f);

    box.append(field('Role', dropdown(ROLES.map(r => [r, r]), node.role || 'system', (v) => {
        node.role = v; touch(); canvas.render();
    })));

    box.append(field('Instruction goes', dropdown([
        ['after', 'after the wired blocks (the usual choice)'],
        ['before', 'before the wired blocks'],
    ], node.contentPosition ?? 'after', (v) => { node.contentPosition = v; touch(); canvas.render(); renderInspector(); })));

    box.append(checkline('Send the last instruction as the user’s turn', node.instructionAsUser !== false, (v) => { node.instructionAsUser = v; touch(); }));
    renderRepeatFields(box, node);
    box.append(el('div', 'pc-hint', 'On by default. Most providers move system messages to the top, so an instruction placed after the chat as a system message is read before the chat — and the model answers the roleplay instead of the task. This makes the instruction the last thing it is asked.'));

    box.append(el('hr', 'pc-rule'));

    const max = el('input', 'text_pole');
    max.type = 'number'; max.min = '1';
    max.value = node.maxTokens ?? 2000;
    max.addEventListener('input', () => { node.maxTokens = Number(max.value) || 2000; touch(); canvas.render(); });
    box.append(field('Longest reply (tokens)', max, 'Keep it tight. A pass that rambles costs you context in the real send.'));

    box.append(field('Let the model think first', dropdown([
        ['off', 'No \u2014 answer straight away'],
        ['low', 'A little'],
        ['medium', 'Some'],
        ['high', 'A lot'],
        ['inherit', 'Whatever the connection says'],
    ], node.thinking ?? 'off', (v) => { node.thinking = v; touch(); canvas.render(); renderInspector(); }),
    (node.thinking ?? 'off') === 'off'
        ? 'Reasoning models spend their token budget thinking before they write, out of the same allowance as the reply. Off keeps the whole allowance for the answer.'
        : 'The model\u2019s hidden thinking comes out of the token limit above, so leave it room.'));

    box.append(field('Its reply arrives as', dropdown(ROLES.map(r => [r, r]), node.outputRole || 'system', (v) => {
        node.outputRole = v; touch(); canvas.render();
    })));

    const prefix = el('textarea', 'text_pole pc-textarea');
    prefix.rows = 2;
    prefix.value = node.prefix ?? '';
    prefix.placeholder = 'Your notes for this scene:';
    prefix.addEventListener('input', () => { node.prefix = prefix.value; touch(); canvas.render(); });
    box.append(field('Before the reply', prefix, 'Framing wrapped around the reply as it goes on down.'));

    const suffix = el('textarea', 'text_pole pc-textarea');
    suffix.rows = 2;
    suffix.value = node.suffix ?? '';
    suffix.addEventListener('input', () => { node.suffix = suffix.value; touch(); canvas.render(); });
    box.append(field('After the reply', suffix));

    box.append(el('hr', 'pc-rule'));

    box.append(checkline('Show the reply under the message', node.showInChat !== false, (v) => {
        node.showInChat = v; touch(); canvas.render(); renderInspector();
    }));

    if (node.showInChat !== false) {
        const label = el('input', 'text_pole');
        label.value = node.label ?? '';
        label.placeholder = 'optional';
        label.addEventListener('input', () => { node.label = label.value; touch(); });
        box.append(field('Extra heading in the chat', label, 'The block\u2019s name is always shown; this is added beside it.'));
    }
}

/** Repeat: run a Generate block several times, each pass on its own answer. */
function renderRepeatFields(box, node) {
    box.append(el('hr', 'pc-rule'));
    const passes = el('input', 'text_pole');
    passes.type = 'number'; passes.min = '1'; passes.max = '10';
    passes.value = node.repeat ?? 1;
    passes.addEventListener('change', () => {
        node.repeat = Math.max(1, Math.min(10, Math.round(Number(passes.value) || 1)));
        passes.value = node.repeat;
        touch(); canvas.render(); renderInspector();
    });
    box.append(field('Passes', passes, 'More than 1 runs this block again on its own answer, for jobs like "remove the AI slop from this text". Each pass is a model call.'));
    if (Number(node.repeat) > 1) {
        box.append(checkline('Stop early when a pass changes nothing', node.repeatStopWhenSame !== false, (v) => { node.repeatStopWhenSame = v; touch(); canvas.render(); }));
        const again = el('textarea', 'text_pole pc-textarea');
        again.rows = 2;
        again.value = node.repeatPrompt ?? '';
        again.placeholder = 'Empty: ask the same instruction again';
        again.addEventListener('input', () => { node.repeatPrompt = again.value; touch(); });
        box.append(field('Ask on each extra pass', again));
    }
}

/**
 * "Send what?": the wire's filter. Picks which messages, and which part of
 * their text, actually cross this wire.
 */
function renderSelectFields(box, wire) {
    const s = { ...DEFAULT_SELECT, ...(wire.select ?? {}) };
    const wrap = el('div', 'pc-select-box');
    box.append(wrap);

    const head = el('div', 'pc-select-head');
    head.append(el('span', 'pc-select-title', 'Send what?'));
    const summary = el('span', 'pc-select-summary', selectLabel(wire.select) || 'everything');
    head.append(summary);
    wrap.append(head);

    /** Save a change. `redraw` re-renders the inspector, for changes that show or hide fields. */
    const set = (patch, redraw = false) => {
        const next = { ...s, ...patch };
        Object.assign(s, patch);
        if (selectActive(next)) wire.select = next; else delete wire.select;
        summary.textContent = selectLabel(wire.select) || 'everything';
        touch();
        canvas.render();
        if (redraw) renderInspector();
    };
    const numberBox = (value, min, onInput) => {
        const i = el('input', 'text_pole pc-select-num');
        i.type = 'number'; i.min = String(min);
        i.value = value;
        i.addEventListener('input', () => onInput(Math.max(min, Math.round(Number(i.value) || 0))));
        return i;
    };
    const row = (...kids) => { const r = el('div', 'pc-select-row'); r.append(...kids); return r; };

    // --- messages ---
    wrap.append(el('div', 'pc-select-sub', 'Messages'));
    const count = dropdown([['all', 'All messages'], ['last', 'The last'], ['first', 'The first']], s.count, (v) => set({ count: v }, true));
    wrap.append(field('How many', s.count === 'all' ? count : row(count, numberBox(s.n, 1, (v) => set({ n: v })))));

    wrap.append(field('From', dropdown([['any', 'Anyone'], ['user', 'Only the user'], ['char', 'Only the character']], s.who, (v) => set({ who: v }))));

    const nums = el('input', 'text_pole');
    nums.placeholder = 'e.g. 23, 25, 30-35';
    nums.value = s.numbers;
    nums.addEventListener('input', () => set({ numbers: nums.value }));
    wrap.append(field('Only message numbers', nums, 'The # numbers SillyTavern shows on each message. Leave empty for any.'));

    wrap.append(field('Leave out the newest', row(numberBox(s.skip, 0, (v) => set({ skip: v })), el('span', 'pc-hint', 'messages'))));

    // --- text ---
    wrap.append(el('div', 'pc-select-sub', 'Text'));
    const keep = dropdown([['all', 'The whole text'], ['firstPara', 'The first paragraphs'], ['lastPara', 'The last paragraphs']], s.keep, (v) => set({ keep: v }, true));
    wrap.append(field('Keep', s.keep === 'all' ? keep : row(keep, numberBox(s.paras, 1, (v) => set({ paras: v })))));

    const tag = el('input', 'text_pole');
    tag.placeholder = 'e.g. plan  →  keeps <plan>…</plan>';
    tag.value = s.between;
    tag.addEventListener('input', () => set({ between: tag.value }));
    wrap.append(field('Only the text inside the tag', tag));

    wrap.append(checkline('Remove thinking (<think>…</think>)', s.stripThinking, (v) => set({ stripThinking: v })));

    // --- how it arrives ---
    wrap.append(el('div', 'pc-select-sub', 'Arrives as'));
    wrap.append(checkline('One piece of text, instead of separate messages', s.join, (v) => set({ join: v }, true)));
    if (s.join) wrap.append(checkline('Put the speaker\u2019s name in front of each part', s.labels, (v) => set({ labels: v })));

    // --- preview ---
    const out = el('div', 'pc-select-preview');
    const btns = row();
    const show = el('div', 'pc-btn menu_button');
    show.innerHTML = '<i class="fa-solid fa-eye"></i> Show what it carries now';
    show.addEventListener('click', async () => {
        out.textContent = 'Working\u2026';
        try {
            const live = await gatherContext({ dryRun: true });
            const msgs = wirePreview(current, wire, live);
            const tokens = await countTokens(msgs);
            out.innerHTML = '';
            out.append(el('div', 'pc-hint', msgs.length
                ? `${msgs.length} message${msgs.length === 1 ? '' : 's'} \u00b7 about ${tokens} tokens`
                : 'Nothing \u2014 with this filter, no text crosses the wire.'));
            for (const m of msgs) {
                const card = el('div', 'pc-select-msg');
                card.append(el('div', 'pc-select-role', m.role), el('div', 'pc-select-text', m.content));
                out.append(card);
            }
        } catch (e) {
            out.textContent = `Could not build the preview: ${e?.message ?? e}`;
        }
    });
    btns.append(show);
    if (selectActive(wire.select)) {
        const clear = el('div', 'pc-btn menu_button');
        clear.innerHTML = '<i class="fa-solid fa-filter-circle-xmark"></i> Send everything';
        clear.title = 'Remove this filter';
        clear.addEventListener('click', () => { delete wire.select; touch(); canvas.render(); renderInspector(); });
        btns.append(clear);
    }
    wrap.append(btns, out);
}

/** A wire that sends a result back up the canvas. */
function renderLoopInspector(box, wire, from, to) {
    const key = from?.type === NODE_TYPES.DECIDER
        ? [...(from.keys ?? []), from.fallback].find(k => k?.id === wire.port) : null;
    box.append(el('div', 'pc-insp-title', 'Loop'));
    box.append(el('div', 'pc-hint', `${from?.title ?? '?'}${key ? ` (${key.name})` : ''} \u21ba back to ${to?.title ?? '?'}`));
    box.append(el('div', 'pc-hint', key
        ? `When "${from.title}" chooses ${key.name}, its text goes back to "${to?.title}" and everything in between runs again. Once the limit is reached, ${key.name} is taken off the Decider's list, so it has to choose something else.`
        : `After "${from?.title}" answers, its answer goes back to "${to?.title}" and everything in between runs again. Once the limit is reached, the last answer carries on down the canvas.`));

    const max = el('input', 'text_pole');
    max.type = 'number'; max.min = '1'; max.max = '20';
    max.value = wire.loop.max ?? 3;
    max.addEventListener('input', () => {
        wire.loop.max = Math.max(1, Math.min(20, Math.round(Number(max.value) || 1)));
        touch(); canvas.render();
    });
    box.append(field('Run it again at most', max, 'Each time round costs a model call for every Generate block in the loop.'));

    if (from?.type === NODE_TYPES.GENERATE) {
        box.append(checkline('Stop early if the answer stops changing', wire.loop.stopWhenSame !== false, (v) => { wire.loop.stopWhenSame = v; touch(); }));
    }

    const label = el('input', 'text_pole');
    label.value = wire.loop.label ?? '';
    label.placeholder = 'Your previous attempt, to improve on:';
    label.addEventListener('input', () => { wire.loop.label = label.value || null; touch(); });
    box.append(field(`What "${to?.title ?? 'the block'}" is told`, label, 'Put in front of the text that comes back, so the model knows what it is looking at.'));

    const del = el('div', 'pc-btn menu_button pc-danger');
    del.innerHTML = '<i class="fa-solid fa-trash-can"></i> Remove this loop';
    del.addEventListener('click', () => { disconnect(current, wire.id); selected = null; canvas.render(); renderInspector(); });
    box.append(del);
}

/** Where a Generate block's task comes from, in one sentence. */
function instructionHint(node) {
    const inputs = Object.values(current.wires)
        .filter(w => w.to === node.id && w.kind !== WIRE_KINDS.TOGETHER && !w.loop && w.mode !== 'activate')
        .map(w => current.nodes[w.from]).filter(Boolean)
        .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const own = String(node.content ?? '').trim();
    if (!own && !inputs.length) return 'Nothing is wired in and there is no instruction, so this block has nothing to ask.';
    if (!own) return `Empty, so the last block wired in is the instruction: "${inputs[inputs.length - 1].title}". Type here for a short ask instead.`;
    if (!inputs.length) return 'Nothing is wired in, so this instruction is the whole question.';
    return node.contentPosition === 'before'
        ? 'Sent first, before the blocks wired in.'
        : 'Sent last, after the blocks wired in, so it is the final thing the model reads.';
}

/** Names of the Generate blocks tied to this one. */
function tiedTo(node) {
    if (!current) return [];
    const group = togetherGroup(current, node.id);
    return [...group].filter(id => id !== node.id).map(id => current.nodes[id]?.title).filter(Boolean);
}

async function showBlockPreview(node, box) {
    const slot = box.querySelector('.pc-test-slot');
    slot.innerHTML = '';

    let p;
    try { p = await previewBlock(current, node); }
    catch (err) { slot.append(el('div', 'pc-error', String(err?.message ?? err))); return; }

    const panel = el('div', 'pc-test pc-test-preview');
    const head = el('div', 'pc-test-head');
    head.textContent = p.messages.length
        ? `${p.messages.length} message${p.messages.length === 1 ? '' : 's'} \u00b7 ${p.chars.toLocaleString()} characters`
        : 'Nothing would be sent';
    panel.append(head);

    const where = [p.profile ?? 'the chat\u2019s connection'];
    if (p.model) where.push(p.model);
    where.push(`up to ${p.maxTokens} tokens`);
    where.push(p.thinking === 'off' ? 'no model thinking' : `thinking: ${p.thinking}`);
    panel.append(el('div', 'pc-test-note', where.join(' \u00b7 ')));

    if (p.note) panel.append(el('div', 'pc-test-note', `Will be fixed up before sending: ${p.note}.`));
    for (const w of [...new Set(p.warnings)]) panel.append(el('div', 'pc-test-problem', w));
    for (const pr of p.problems) panel.append(el('div', 'pc-test-problem', pr));

    for (const m of p.messages) {
        panel.append(el('div', 'pc-msg-role', m.role));
        panel.append(el('div', 'pc-msg-text', m.content));
    }
    if (!p.messages.length) {
        panel.append(el('div', 'pc-hint', 'Wire something into the top of this block, or give it text of its own.'));
    }
    slot.append(panel);
}

async function runBlockTest(node, button, box) {
    const slot = box.querySelector('.pc-test-slot');
    const original = button.innerHTML;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Asking';
    slot.innerHTML = '';

    let res;
    try {
        res = await testBlock(current, node);
    } catch (err) {
        res = { ok: false, error: String(err?.message ?? err) };
    }
    button.innerHTML = original;

    const panel = el('div', res.ok ? 'pc-test pc-test-ok' : 'pc-test pc-test-bad');
    const head = el('div', 'pc-test-head');
    head.textContent = res.ok
        ? `Replied in ${((res.ms ?? 0) / 1000).toFixed(1)}s${res.profile ? ` via ${res.profile}` : ''}`
        : 'Failed';
    panel.append(head);

    if (res.usage) {
        const think = res.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        const bits = [`${res.usage.completion_tokens ?? 0} reply tokens`];
        if (think) bits.push(`${think} of them spent thinking`);
        if (res.finish && res.finish !== 'stop') bits.push(`stopped: ${res.finish}`);
        panel.append(el('div', 'pc-test-note', bits.join(' \u00b7 ')));
    }
    if (res.cutoff) panel.append(el('div', 'pc-test-problem', res.cutoff));

    if (res.note) {
        panel.append(el('div', 'pc-test-note', `Fixed up before sending: ${res.note}.`));
    }
    for (const f of res.fills ?? []) panel.append(el('div', 'pc-test-note', f));
    for (const pr of res.problems ?? []) panel.append(el('div', 'pc-test-problem', pr));
    panel.append(el('div', 'pc-test-body', res.ok ? res.text : res.error));

    if (res.messages?.length) {
        const sent = el('details', 'pc-test-sent');
        sent.append(el('summary', '', `What was sent (${res.messages.length} message${res.messages.length === 1 ? '' : 's'})`));
        for (const m of res.messages) {
            sent.append(el('div', 'pc-msg-role', m.role));
            sent.append(el('div', 'pc-msg-text', m.content));
        }
        panel.append(sent);
    }
    slot.append(panel);
}

/** Lorebook: which lorebooks, which entries, how much, and how they read. */
function renderLoreFields(box, node) {
    const redraw = () => { touch(); canvas.render(); renderInspector(); };
    const soft = () => { touch(); canvas.render(); };
    const lore = liveCache?.lore;
    node.sources ??= { chat: true, character: true, persona: false, global: false };
    node.books ??= [];
    const numberBox = (value, min, onInput, cls = 'pc-select-num') => {
        const i = el('input', `text_pole ${cls}`);
        i.type = 'number'; i.min = String(min); i.value = value;
        i.addEventListener('input', () => onInput(Math.max(min, Math.round(Number(i.value) || 0))));
        return i;
    };
    const row = (...kids) => { const r = el('div', 'pc-select-row'); r.append(...kids); return r; };

    box.append(el('div', 'pc-hint', 'Reads your lorebooks directly, so this block decides which entries are sent and where. Anything wired into it is text to scan for keys, and stops here.'));

    // 1. which lorebooks
    box.append(el('div', 'pc-select-sub', 'Lorebooks'));
    const linked = el('div', 'pc-checks');
    const say = (list) => (list?.length ? `: ${list.join(', ')}` : lore ? ': none' : '');
    for (const [k, label] of [['chat', 'The chat’s'], ['character', 'The character’s'], ['persona', 'The persona’s'], ['global', 'Global (switched on in World Info)']]) {
        linked.append(checkline(`${label}${say(lore?.sources?.[k])}`, !!node.sources[k], (v) => { node.sources[k] = v; refreshLive().then(redraw); }));
    }
    box.append(linked);
    const names = (lore?.names ?? []).filter(n => !node.books.includes(n));
    const chips = el('div', 'pc-dest-chips');
    for (const b of node.books) {
        const chip = el('span', 'pc-dest-chip', b);
        const x = el('i', 'fa-solid fa-xmark pc-dest-x');
        x.addEventListener('click', () => { node.books = node.books.filter(n => n !== b); touch(); refreshLive().then(redraw); });
        chip.append(x);
        chips.append(chip);
    }
    const add = el('select', 'pc-select text_pole');
    add.append(Object.assign(el('option', '', names.length ? '+ add a lorebook…' : 'no other lorebooks found'), { value: '' }));
    for (const n of names) add.append(Object.assign(el('option', '', n), { value: n }));
    add.addEventListener('change', () => { if (!add.value) return; node.books.push(add.value); touch(); refreshLive().then(redraw); });
    box.append(field('Also these', row(chips, add)));

    // 2. which entries
    box.append(el('div', 'pc-select-sub', 'Which entries'));
    box.append(field('Send', dropdown([
        ['st', 'As SillyTavern would (keys, constant…)'],
        ['scan', 'Entries whose keys appear in…'],
        ['all', 'Every entry'],
        ['constant', 'Only constant entries'],
        ['picked', 'Only the entries I pick'],
    ], node.mode ?? 'st', (v) => { node.mode = v; redraw(); }), {
        st: 'On a send, exactly what SillyTavern activated. The preview can only estimate it (constant entries, and keys in the last messages it scans).',
        scan: 'Keys are matched the way SillyTavern matches them (regex keys, whole words, case), without its extras such as sticky, cooldown or vectors.',
    }[node.mode ?? 'st'] ?? ''));
    if (node.mode === 'scan') {
        const from = dropdown([['inputs', 'the text wired into this block'], ['chat', 'the last messages of the chat']], node.scanFrom ?? 'inputs', (v) => { node.scanFrom = v; redraw(); });
        box.append(field('Scan', node.scanFrom === 'chat' ? row(from, numberBox(node.scanDepth ?? 4, 1, (v) => { node.scanDepth = v; soft(); }), el('span', 'pc-hint', 'messages')) : from,
            node.scanFrom === 'chat' ? '' : 'For example, wire a Generate block that plans the scene into this one, and the lore for whatever it mentions comes along.'));
        box.append(checkline('Also send constant entries', node.includeConstant !== false, (v) => { node.includeConstant = v; soft(); }));
    }
    if (node.mode === 'picked') {
        const list = el('div', 'pc-lore-pick');
        const want = new Set(node.picked ?? []);
        let any = false;
        for (const b of blockBooksOf(node)) {
            const entries = lore?.books?.[b] ?? [];
            if (!entries.length) continue;
            list.append(el('div', 'pc-select-sub', b));
            for (const e of entries) {
                any = true;
                const id = `${b}|${e.uid}`;
                list.append(checkline(e.title || `#${e.uid}${e.keys.length ? ` (${e.keys.slice(0, 3).join(', ')})` : ''}`, want.has(id), (v) => {
                    if (v) want.add(id); else want.delete(id);
                    node.picked = [...want]; soft();
                }));
            }
        }
        if (!any) list.append(el('div', 'pc-hint', lore ? 'No entries found in the chosen lorebooks.' : 'Open a chat to list the entries.'));
        box.append(list);
    }

    // filters
    const title = el('input', 'text_pole');
    title.placeholder = 'e.g. Tavern, Sword';
    title.value = node.titleFilter ?? '';
    title.addEventListener('input', () => { node.titleFilter = title.value; soft(); });
    box.append(field('Only titles containing', title, 'Comma-separated. Leave empty for any.'));
    const group = el('input', 'text_pole');
    group.placeholder = 'any group';
    group.value = node.group ?? '';
    group.addEventListener('input', () => { node.group = group.value; soft(); });
    box.append(field('Only the group', group));
    box.append(field('Only entries set to', dropdown(LORE_POSITIONS, String(node.position ?? 'any'), (v) => { node.position = v; soft(); })));
    box.append(checkline('Only memories written by the Memory Books extension', !!node.memoryOnly, (v) => { node.memoryOnly = v; redraw(); }));
    if (node.memoryOnly) {
        box.append(field('Skip memories of the last', row(numberBox(node.skipRecent ?? 0, 0, (v) => { node.skipRecent = v; soft(); }), el('span', 'pc-hint', 'messages (0 = none)')),
            'So a scene still in the chat history you send is not told twice.'));
    }
    box.append(checkline('Include entries switched off in the lorebook', !!node.includeDisabled, (v) => { node.includeDisabled = v; soft(); }));

    // 3. how much
    box.append(el('div', 'pc-select-sub', 'How much'));
    box.append(field('At most', row(numberBox(node.maxEntries ?? 0, 0, (v) => { node.maxEntries = v; soft(); }), el('span', 'pc-hint', 'entries, and'),
        numberBox(node.tokenBudget ?? 0, 0, (v) => { node.tokenBudget = v; soft(); }, 'pc-select-num pc-wide-num'), el('span', 'pc-hint', 'tokens (0 = no limit)')),
        'When there are too many, the entries at the end of the order are kept: the highest order, or the most recently mentioned.'));
    box.append(field('Order', dropdown([['order', 'By the entries’ own order'], ['recent', 'Most recently mentioned last'], ['alpha', 'Alphabetical']], node.order ?? 'order', (v) => { node.order = v; soft(); })));

    // 4. how it is sent
    box.append(el('div', 'pc-select-sub', 'How it is sent'));
    box.append(field('Role', dropdown(ROLES.map(r => [r, r]), node.role || 'system', (v) => { node.role = v; soft(); })));
    box.append(checkline('Put each entry’s title above it', !!node.titles, (v) => { node.titles = v; soft(); }));
    box.append(checkline('One message per entry', !!node.separate, (v) => { node.separate = v; soft(); }));
    for (const [k, label, ph] of [['prefix', 'Put in front', 'e.g. What the world knows:'], ['suffix', 'Put after', '']]) {
        const t = el('textarea', 'text_pole pc-textarea');
        t.rows = 2; t.placeholder = ph; t.value = node[k] ?? '';
        t.addEventListener('input', () => { node[k] = t.value; soft(); });
        box.append(field(label, t));
    }

    // 5. with the rest of the canvas
    box.append(el('div', 'pc-select-sub', 'With the rest of the canvas'));
    box.append(checkline('Keep these lorebooks out of World Info, so nothing is sent twice', !!node.excludeFromWI, (v) => { node.excludeFromWI = v; soft(); }));
    box.append(el('div', 'pc-hint', 'To route on which lore fired, wire this block into a Decider and set the wire to Forward result: it then carries the entry names.'));

    // preview
    const out = el('div', 'pc-select-preview');
    const show = el('div', 'pc-btn menu_button');
    show.innerHTML = '<i class="fa-solid fa-eye"></i> Which entries fire now?';
    show.addEventListener('click', async () => {
        out.textContent = 'Looking…';
        try {
            const live = await refreshLive();
            const built = collect(current, node.id, live, {});
            const entries = built.fired?.[node.id] ?? [];
            out.innerHTML = '';
            const t = built.trace.find(x => x.id === node.id);
            out.append(el('div', 'pc-hint', entries.length
                ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, about ${Math.ceil(textOf(built.messages).length / 4)} tokens${t?.why?.includes('estimated') ? ' — estimated: on a send, SillyTavern decides' : ''}`
                : 'No entries fire right now.'));
            for (const e of entries) {
                const r = el('div', 'pc-dec-test-row pc-yes');
                r.innerHTML = `<i class="fa-solid fa-book"></i> <b>${escapeHtml(e.title || `#${e.uid}`)}</b> <span>${escapeHtml(e.why)} · ${escapeHtml(e.book)}</span>`;
                out.append(r);
            }
            for (const w of built.warnings) out.append(el('div', 'pc-hint', w));
            for (const er of live?.lore?.errors ?? []) out.append(el('div', 'pc-hint', er));
        } catch (e) {
            out.textContent = `Could not look: ${e?.message ?? e}`;
        }
    });
    box.append(show, out);
}

/** The lorebooks a Lorebook block reads, from the last gathered context. */
function blockBooksOf(node) {
    const s = node.sources ?? {};
    const src = liveCache?.lore?.sources ?? {};
    return [...new Set([...(s.chat ? src.chat ?? [] : []), ...(s.character ? src.character ?? [] : []), ...(s.persona ? src.persona ?? [] : []), ...(s.global ? src.global ?? [] : []), ...(node.books ?? [])])];
}

function renderInjectionFields(box, node) {
    const wrap = el('div', 'pc-checks');
    for (const key of ['worldInfoBefore', 'worldInfoAfter', 'authorsNote', 'summary', 'vectorsMemory', 'vectorsDataBank', 'smartContext']) {
        wrap.append(checkline(key, (node.sources ?? []).includes(key), (on) => {
            const set = new Set(node.sources ?? []);
            on ? set.add(key) : set.delete(key);
            node.sources = [...set];
            touch(); canvas.render();
        }));
    }
    box.append(field('Pull in', wrap, 'Content other extensions have injected. Empty ones are skipped.'));
}

function renderConditionEditor(box, node) {
    node.condition ??= { mode: 'always' };
    renderRuleFields(box, node.condition, {
        label: 'Include this block',
        modes: BLOCK_RULE_MODES,
        scopes: SEARCH_SCOPES,
    });
}

const BLOCK_RULE_MODES = [
    ['always', 'Always'],
    ['probability', 'Probability'],
    ['search', 'Term search'],
    ['variable', 'Variable'],
    ['model', 'Model name'],
    ['time', 'Time of day'],
    ['chat', 'Chat length / last speaker'],
    ['character', 'Character name'],
];
const KEY_RULE_MODES = [
    ['search', 'Contains words or phrases'],
    ['lacks', 'Does not contain words or phrases'],
    ['number', 'Number comparison (math)'],
    ['ai', 'Ask the AI a yes/no question'],
    ['probability', 'Probability'],
    ['time', 'Time of day'],
    ['chat', 'Chat length / last speaker'],
    ['variable', 'Variable'],
    ['character', 'Character name'],
    ['model', 'Model name'],
    ['always', 'Always'],
];
const SEARCH_SCOPES = [
    ['lastUser', 'last user message'],
    ['lastAssistant', 'last reply'],
    ['lastN', 'last N messages'],
    ['chat', 'whole chat'],
];
const KEY_SCOPES = [['incoming', 'the text coming in'], ...SEARCH_SCOPES];
const OPS = [['gt', 'more than'], ['gte', 'at least'], ['lt', 'fewer than'], ['lte', 'at most'], ['eq', 'exactly']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The controls for one rule. Blocks use one to decide whether they are
 * included; each Decider key has a list of them.
 */
function renderRuleFields(box, c, { label = 'Rule', modes = BLOCK_RULE_MODES, scopes = SEARCH_SCOPES } = {}) {
    const redraw = () => { touch(); canvas.render(); renderInspector(); };
    const soft = () => { touch(); canvas.render(); };
    const num = (value, onInput, attrs = {}) => {
        const n = el('input', 'text_pole');
        n.type = 'number';
        Object.assign(n, attrs);
        n.value = value;
        n.addEventListener('input', () => onInput(Number(n.value)));
        return n;
    };
    const text = (value, onInput, placeholder = '') => {
        const t = el('input', 'text_pole');
        t.value = value ?? '';
        t.placeholder = placeholder;
        t.addEventListener('input', () => onInput(t.value));
        return t;
    };

    box.append(field(label, dropdown(modes, c.mode ?? modes[0][0], (v) => { c.mode = v; redraw(); })));

    if (c.mode === 'probability') {
        box.append(field('Chance (%)', num(c.chance ?? 100, v => { c.chance = v; soft(); }, { min: '0', max: '100' }), 'Rolled fresh on every send.'));
    }

    if (c.mode === 'search' || c.mode === 'lacks') {
        const terms = el('textarea', 'text_pole pc-textarea');
        terms.rows = 4;
        terms.placeholder = 'one word or phrase per line';
        terms.value = c.terms ?? '';
        terms.addEventListener('input', () => { c.terms = terms.value; soft(); });
        box.append(field('Words or phrases', terms));

        if (c.mode === 'search') {
            box.append(field('Match', dropdown([
                ['any', 'any of them appears'],
                ['all', 'all of them appear'],
                ['none', 'none of them appears'],
            ], c.matchMode ?? 'any', (v) => { c.matchMode = v; soft(); })));
        } else {
            box.append(el('div', 'pc-hint', 'Matches when none of these appears.'));
        }

        box.append(field('Look in', dropdown(scopes, c.scope ?? scopes[0][0], (v) => { c.scope = v; redraw(); })));

        if ((c.scope ?? scopes[0][0]) === 'lastN') {
            box.append(field('How many messages', num(c.n ?? 3, v => { c.n = v || 3; touch(); }, { min: '1' })));
        }

        box.append(checkline('Treat as regular expressions', c.regex, (v) => { c.regex = v; touch(); }));
        box.append(checkline('Case sensitive', c.caseSensitive, (v) => { c.caseSensitive = v; touch(); }));
    }

    if (c.mode === 'number') {
        box.append(field('Take this number', dropdown([
            ['words', 'words in the text coming in'],
            ['chars', 'characters in the text coming in'],
            ['found', 'how often some words appear in it'],
            ['messages', 'messages in the chat'],
            ['turns', 'your turns in the chat'],
            ['variable', 'a variable\u2019s value'],
            ['roll', 'a dice roll, 1 to 100'],
        ], c.source ?? 'words', (v) => { c.source = v; redraw(); })));
        if (c.source === 'variable') {
            box.append(field('Variable name', text(c.name, v => { c.name = v; soft(); })));
            box.append(field('Scope', dropdown([['local', 'chat variable'], ['global', 'global variable']],
                c.scope === 'global' ? 'global' : 'local', (v) => { c.scope = v; touch(); })));
        }
        if (c.source === 'found') {
            const terms = el('textarea', 'text_pole pc-textarea');
            terms.rows = 3;
            terms.placeholder = 'one word or phrase per line';
            terms.value = c.terms ?? '';
            terms.addEventListener('input', () => { c.terms = terms.value; soft(); });
            box.append(field('Count these', terms));
        }
        const row = el('div', 'pc-row');
        row.append(
            dropdown([...OPS, ['every', 'a multiple of']], c.op ?? 'gt', (v) => { c.op = v; soft(); }),
            num(c.value ?? 0, v => { c.value = v; soft(); }),
        );
        box.append(field('Matches when it is', row));
    }

    if (c.mode === 'ai') {
        const q = el('textarea', 'text_pole pc-textarea');
        q.rows = 3;
        q.placeholder = 'Does this text contain clich\u00e9d AI phrasing?';
        q.value = c.question ?? '';
        q.addEventListener('input', () => { c.question = q.value; soft(); });
        box.append(field('Question', q, 'The model is shown the text coming in and asked this, answering only YES or NO. YES matches. It is one small extra model call, made only if no key above has already matched. An unclear answer counts as NO.'));
        const m = text(c.model, v => { c.model = v || null; touch(); }, 'same model as the chat');
        box.append(field('Model (optional)', m, 'A small, fast model is plenty for a yes/no question.'));
    }

    if (c.mode === 'length') {
        const row = el('div', 'pc-row');
        row.append(
            dropdown(OPS, c.op ?? 'gt', (v) => { c.op = v; soft(); }),
            num(c.value ?? 300, v => { c.value = v; soft(); }, { min: '0' }),
            dropdown([['words', 'words'], ['chars', 'characters']], c.unit ?? 'words', (v) => { c.unit = v; soft(); }),
        );
        box.append(field('The text coming in is', row));
    }

    if (c.mode === 'time') {
        const row = el('div', 'pc-row');
        const from = el('input', 'text_pole'); from.type = 'time'; from.value = c.from ?? '22:00';
        const to = el('input', 'text_pole'); to.type = 'time'; to.value = c.to ?? '06:00';
        c.from ??= from.value; c.to ??= to.value;
        from.addEventListener('input', () => { c.from = from.value; soft(); });
        to.addEventListener('input', () => { c.to = to.value; soft(); });
        row.append(from, el('span', 'pc-hint', 'to'), to);
        box.append(field('Between', row, 'Your computer’s clock. A range like 22:00 to 06:00 runs past midnight.'));
        const days = el('div', 'pc-row pc-days');
        const on = new Set((c.days ?? []).map(Number));
        DAYS.forEach((d, i) => {
            days.append(checkline(d, on.has(i), (v) => {
                v ? on.add(i) : on.delete(i);
                c.days = [...on].sort();
                soft();
            }));
        });
        box.append(field('On these days (none ticked = every day)', days));
    }

    if (c.mode === 'chat') {
        box.append(field('Check', dropdown([
            ['messages', 'number of messages'],
            ['turn', 'number of your turns'],
            ['lastSpeaker', 'who spoke last'],
        ], c.what ?? 'messages', (v) => { c.what = v; redraw(); })));
        if ((c.what ?? 'messages') === 'lastSpeaker') {
            box.append(field('Last message is from', dropdown([['user', 'you'], ['character', 'the character']],
                c.value || 'user', (v) => { c.value = v; soft(); })));
        } else {
            const row = el('div', 'pc-row');
            row.append(
                dropdown([...OPS, ['every', 'every']], c.op ?? 'gte', (v) => { c.op = v; soft(); }),
                num(c.value ?? 10, v => { c.value = v; soft(); }, { min: '0' }),
            );
            box.append(field('Is', row, c.op === 'every' ? '"every 5" matches on the 5th, 10th, 15th…' : ''));
        }
    }

    if (c.mode === 'variable') {
        box.append(field('Variable name', text(c.name, v => { c.name = v; soft(); })));
        box.append(field('Scope', dropdown([['local', 'chat variable'], ['global', 'global variable']],
            c.scope === 'global' ? 'global' : 'local', (v) => { c.scope = v; touch(); })));
        box.append(field('Test', dropdown([
            ['eq', 'equals'], ['neq', 'does not equal'], ['gt', 'greater than'],
            ['lt', 'less than'], ['contains', 'contains'], ['exists', 'is set'],
        ], c.op ?? 'eq', (v) => { c.op = v; soft(); })));
        box.append(field('Value', text(c.value, v => { c.value = v; soft(); })));
    }

    if (c.mode === 'model') {
        box.append(field('Model name contains', text(c.value, v => { c.value = v; soft(); }, 'claude, gpt-4, gemini…')));
    }

    if (c.mode === 'character') {
        box.append(field('Character name contains', text(c.value, v => { c.value = v; soft(); }, 'Kenzy')));
    }
}

/* ------------------------------------------------------------------ */
/* Decider                                                             */
/* ------------------------------------------------------------------ */

/**
 * Where one key's path goes, chosen from a list, so a key can be wired
 * without hunting for its dot on the canvas. A key can lead to several blocks.
 */
function destinationPicker(node, key) {
    const wrap = el('div', 'pc-dest');
    const out = Object.values(current.wires).filter(w => w.from === node.id && w.port === key.id);
    const chips = el('div', 'pc-dest-chips');
    for (const w of out) {
        const target = current.nodes[w.to];
        const chip = el('span', `pc-dest-chip${w.loop ? ' pc-dest-loop' : ''}`, `${w.loop ? `\u21ba back to ${target?.title || 'missing block'}, up to ${w.loop.max ?? 3}\u00d7` : `\u2192 ${target?.title || 'missing block'}`}`);
        const x = el('i', 'fa-solid fa-xmark pc-dest-x');
        x.title = 'Remove this connection';
        x.addEventListener('click', () => { disconnect(current, w.id); touch(); canvas.render(); renderInspector(); });
        chip.append(x);
        chips.append(chip);
    }
    if (!out.length) chips.append(el('span', 'pc-hint pc-dest-none', 'goes nowhere yet'));

    const choices = Object.values(current.nodes)
        .filter(n => n.id !== node.id && n.type !== NODE_TYPES.NOTE && !out.some(w => w.to === n.id))
        .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const sel = el('select', 'pc-select text_pole');
    sel.append(Object.assign(el('option', '', out.length ? '+ also go to\u2026' : 'Choose a block\u2026'), { value: '' }));
    for (const n of choices) sel.append(Object.assign(el('option', '', `${n.title || 'Untitled'}${n.type === NODE_TYPES.OUTPUT ? ' (Output)' : ''}`), { value: n.id }));
    sel.addEventListener('change', () => {
        if (!sel.value) return;
        const res = connect(current, node.id, sel.value, WIRE_KINDS.MERGE, { port: key.id });
        if (!res.ok) toast(res.reason, 'warning');
        touch(); canvas.render(); renderInspector();
    });
    wrap.append(field('Goes to', chips), sel);
    return wrap;
}

/** Whether the "?" guide is open in the Decider inspector. */
let guideOpen = false;

/** The Decider guide: short, with two examples you can drop in. */
function deciderGuide(node, redraw) {
    const d = el('details', 'pc-guide');
    d.open = guideOpen;
    d.addEventListener('toggle', () => { guideOpen = d.open; });
    d.append(el('summary', '', 'How Deciders work'));
    const body = el('div', 'pc-guide-body');
    body.innerHTML = `
        <p><b>What it is.</b> A Decider looks at text or the chat, and decides which blocks run. Blocks on paths it does not take are skipped and cost nothing.</p>
        <p><b>Inputs.</b> Wire blocks into its top. Rules can read all of them together, or one on its own.</p>
        <p><b>Outputs.</b> One output per path, each with its own rules. Each output has its own dot on the block’s bottom edge. <b>Otherwise</b> fires when nothing else does, and can be left unwired.</p>
        <p><b>How it routes.</b></p>
        <ul>
            <li><b>Every match</b> — all outputs whose rules hold fire. “red” and “blue” both present: both fire.</li>
            <li><b>First match</b> — outputs are checked top to bottom; only the first that holds fires.</li>
            <li><b>AI sorts</b> — describe each output in plain words; one small model call picks the ones that apply.</li>
            <li><b>Random</b> — a weighted pick.</li>
        </ul>
        <p><b>Wires out of it.</b> Click a wire to choose what travels: <b>Send</b> (solid) passes the text on; <b>Activate</b> (dotted) only switches the block on so it uses its own text; <b>Forward result</b> (dash-dot) sends the decision itself — put <code>{{result}}</code> in the next block.</p>
        <p><b>Try it.</b> Use the test box at the bottom: paste some text and see which outputs light up.</p>`;
    d.append(body);

    const examples = el('div', 'pc-row pc-guide-examples');
    const example = (label, apply) => {
        const b = el('div', 'pc-btn menu_button', label);
        b.addEventListener('click', async () => {
            if ((node.keys ?? []).length && !await confirmBox(`Replace the outputs of "${node.title}" with this example? Their wires are removed too.`)) return;
            for (const k of [...(node.keys ?? [])]) removeDeciderKey(current, node, k.id);
            apply();
            guideOpen = false;
            redraw();
        });
        return b;
    };
    const words = (name, terms) => ({ ...newDeciderKey(name), conditions: [{ mode: 'search', scope: 'incoming', terms, matchMode: 'any' }] });
    examples.append(
        example('Example: colour router', () => {
            node.mode = 'all';
            node.keys = [words('Red', 'red\ncrimson\nscarlet'), words('Blue', 'blue\nazure\nnavy')];
        }),
        example('Example: AI yes/no', () => {
            node.mode = 'first';
            node.keys = [{ ...newDeciderKey('Yes'), conditions: [{ mode: 'ai', question: 'Is the character angry in this text?' }] }];
            node.fallback.name = 'No';
        }),
    );
    d.append(examples);
    return d;
}

/** Whether a rule reads the text wired in (so it can be pointed at one input). */
function readsInput(c) {
    if (!c) return false;
    if (c.mode === 'search' || c.mode === 'lacks') return (c.scope ?? 'incoming') === 'incoming';
    if (c.mode === 'length' || c.mode === 'ai') return true;
    if (c.mode === 'number') return ['words', 'chars', 'found', undefined].includes(c.source);
    return false;
}

function renderDeciderFields(box, node) {
    const redraw = () => { touch(); canvas.render(); renderInspector(); };
    node.keys ??= [];
    node.fallback ??= { id: `k_${Date.now().toString(36)}`, name: 'Otherwise', weight: 1 };
    const mode = routingMode(node);

    box.append(deciderGuide(node, redraw));

    box.append(field('How it routes', dropdown([
        ['', 'Choose…'],
        ['all', 'Every output that matches'],
        ['first', 'Only the first match'],
        ['ai', 'Let the AI sort'],
        ['random', 'Random (weighted)'],
    ], mode ?? '', (v) => { node.mode = v || null; redraw(); }), {
        all: 'Every output whose rules hold fires. Several can fire at once.',
        first: 'Outputs are checked top to bottom. Only the first that holds fires.',
        ai: 'One small model call reads the text and picks the outputs that apply, by their descriptions.',
        random: 'A weighted pick. No rules.',
    }[mode] ?? 'Not set up yet. Until you choose, nothing below this Decider is sent. The “How Deciders work” guide above has two examples to start from.'));

    // Inputs: the blocks wired into its top.
    const inputs = deciderInputList(current, node);
    const inBox = el('div', 'pc-dest-chips');
    if (!inputs.length) inBox.append(el('span', 'pc-hint pc-dest-none', 'nothing wired in — rules can still read the chat'));
    for (const i of inputs) inBox.append(el('span', 'pc-dest-chip', `↓ ${i.title}`));
    box.append(field('Inputs', inBox, inputs.length > 1 ? 'Each rule can read all of them together, or one on its own.' : ''));

    // Outputs.
    box.append(el('div', 'pc-select-sub', 'Outputs'));
    node.keys.forEach((k, i) => {
        const card = el('div', 'pc-key-card');
        const head = el('div', 'pc-key-head');
        const name = el('input', 'text_pole pc-key-name');
        name.value = k.name ?? '';
        name.placeholder = 'Output name';
        name.addEventListener('input', () => { k.name = name.value; touch(); canvas.render(); });
        head.append(name);
        const tool = (icon, title, fn, off = false) => {
            const b = mkBtn(icon, title, fn, 'pc-key-tool');
            if (off) b.classList.add('pc-disabled');
            return b;
        };
        head.append(
            tool('fa-arrow-up', 'Move up', () => { if (i) { [node.keys[i - 1], node.keys[i]] = [node.keys[i], node.keys[i - 1]]; redraw(); } }, i === 0),
            tool('fa-arrow-down', 'Move down', () => { if (i < node.keys.length - 1) { [node.keys[i + 1], node.keys[i]] = [node.keys[i], node.keys[i + 1]]; redraw(); } }, i === node.keys.length - 1),
            tool('fa-clone', 'Duplicate this output (without its wires)', () => {
                const copy = structuredClone(k);
                copy.id = newDeciderKey().id;
                copy.name = `${k.name || 'Output'} copy`;
                node.keys.splice(i + 1, 0, copy);
                redraw();
            }),
            tool('fa-trash-can', 'Remove this output and its wires', () => { removeDeciderKey(current, node, k.id); redraw(); }),
        );
        card.append(head);
        card.append(destinationPicker(node, k));

        if (mode === 'random') {
            const w = el('input', 'text_pole');
            w.type = 'number'; w.min = '0'; w.value = k.weight ?? 1;
            w.addEventListener('input', () => { k.weight = Math.max(0, Number(w.value) || 0); touch(); canvas.render(); });
            card.append(field('Weight', w));
        } else if (mode === 'ai') {
            const d = el('textarea', 'text_pole pc-textarea');
            d.rows = 2;
            d.placeholder = 'When should this fire? e.g. The scene turns violent or someone is hurt.';
            d.value = k.description ?? '';
            d.addEventListener('input', () => { k.description = d.value; touch(); canvas.render(); });
            card.append(field('Description for the AI', d));
        } else {
            k.conditions ??= [];
            if (k.conditions.length > 1) {
                card.append(field('Fires when', dropdown([['any', 'any rule below holds (OR)'], ['all', 'every rule below holds (AND)']],
                    k.match ?? 'any', (v) => { k.match = v; touch(); canvas.render(); })));
            }
            k.conditions.forEach((c, ci) => {
                const rule = el('div', 'pc-key-rule');
                renderRuleFields(rule, c, { label: k.conditions.length > 1 ? `Rule ${ci + 1}` : 'Rule', modes: KEY_RULE_MODES, scopes: KEY_SCOPES });
                if (inputs.length > 1 && readsInput(c)) {
                    const pairs = [['', 'all inputs together'], ...inputs.map(x => [x.wireId, x.title])];
                    if (c.input && !inputs.some(x => x.wireId === c.input)) pairs.push([c.input, '(a wire that is gone)']);
                    rule.append(field('Reads', dropdown(pairs, c.input ?? '', (v) => { if (v) c.input = v; else delete c.input; touch(); canvas.render(); })));
                }
                rule.append(checkline('NOT — flip it: holds when this is not true', !!c.not, (v) => { if (v) c.not = true; else delete c.not; touch(); canvas.render(); }));
                if (k.conditions.length > 1) {
                    const rm = el('a', 'pc-key-rm', 'remove this rule');
                    rm.href = 'javascript:void(0)';
                    rm.addEventListener('click', () => { k.conditions.splice(ci, 1); redraw(); });
                    rule.append(rm);
                }
                card.append(rule);
            });
            const add = el('a', 'pc-key-add', '+ another rule for this output');
            add.href = 'javascript:void(0)';
            add.addEventListener('click', () => { k.conditions.push({ mode: 'search', scope: 'incoming', terms: '', matchMode: 'any' }); redraw(); });
            card.append(add);
        }
        box.append(card);
    });

    const addKey = el('div', 'pc-btn menu_button');
    addKey.innerHTML = '<i class="fa-solid fa-plus"></i> Add an output';
    addKey.addEventListener('click', () => {
        node.keys.push(newDeciderKey(`Output ${node.keys.length + 1}`));
        redraw();
    });
    box.append(addKey);

    const fb = el('div', 'pc-key-card pc-key-fallback');
    const fbName = el('input', 'text_pole pc-key-name');
    fbName.value = node.fallback.name ?? 'Otherwise';
    fbName.addEventListener('input', () => { node.fallback.name = fbName.value; touch(); canvas.render(); });
    fb.append(field(mode === 'random' ? 'Fallback output' : 'Otherwise — fires when nothing else does', fbName, mode === 'random' ? '' : 'Can be left unwired: then nothing below this Decider is sent when nothing matches.'));
    fb.append(destinationPicker(node, node.fallback));
    if (mode === 'random') {
        const w = el('input', 'text_pole');
        w.type = 'number'; w.min = '0'; w.value = node.fallback.weight ?? 1;
        w.addEventListener('input', () => { node.fallback.weight = Math.max(0, Number(w.value) || 0); touch(); canvas.render(); });
        fb.append(field('Weight', w));
    }
    box.append(fb);

    if (mode === 'ai') {
        node.sorter ??= {};
        box.append(el('div', 'pc-select-sub', 'AI sorter'));
        box.append(checkline('May pick several outputs', node.sorter.several !== false, (v) => { node.sorter.several = v; touch(); }));
        const notes = el('textarea', 'text_pole pc-textarea');
        notes.rows = 2;
        notes.placeholder = 'Optional: anything else the AI should know when choosing.';
        notes.value = node.sorter.instructions ?? '';
        notes.addEventListener('input', () => { node.sorter.instructions = notes.value; touch(); });
        box.append(field('Extra instructions', notes));
        const m = el('input', 'text_pole');
        m.placeholder = 'same model as the chat';
        m.value = node.sorter.model ?? '';
        m.addEventListener('input', () => { node.sorter.model = m.value || null; touch(); });
        box.append(field('Model (optional)', m, 'A small, fast model is plenty. One short call per send.'));
    }

    box.append(deciderTestBox(node));

    box.append(checkline('Show its choice in the chat', node.showInChat !== false, (v) => { node.showInChat = v; touch(); }));
}

/** Paste text, see which outputs light up. Nothing is sent. */
function deciderTestBox(node) {
    const wrap = el('div', 'pc-select-box pc-dec-test');
    wrap.append(el('div', 'pc-select-title', 'Test it'));
    const sample = el('textarea', 'text_pole pc-textarea');
    sample.rows = 3;
    sample.placeholder = 'Paste some text, as if it came in through the inputs.';
    const out = el('div', 'pc-dec-test-out');
    const go = el('div', 'pc-btn menu_button');
    go.innerHTML = '<i class="fa-solid fa-vial"></i> Test';
    go.addEventListener('click', async () => {
        out.textContent = 'Testing…';
        let live;
        try { live = liveCache ?? await refreshLive(); } catch { live = null; }
        live ??= { chat: [], substitute: t => t, worldInfo: {}, extensionPrompts: {}, card: {} };
        out.innerHTML = '';
        for (const r of explainDecider(node, live, sample.value)) {
            const row = el('div', `pc-dec-test-row ${r.pass === true ? 'pc-yes' : r.pass === false ? 'pc-no' : 'pc-maybe'}`);
            const icon = r.pass === true ? 'fa-circle-check' : r.pass === false ? 'fa-circle-xmark' : 'fa-circle-question';
            row.innerHTML = `<i class="fa-solid ${icon}"></i> <b>${escapeHtml(r.name)}</b> <span>${escapeHtml(r.why)}</span>`;
            out.append(row);
        }
    });
    wrap.append(sample, go, out, el('div', 'pc-hint', 'Rules that read the chat use the chat that is open now. AI rules are not asked here.'));
    return wrap;
}

function renderModelEditor(box, node) {
    const list = profiles();
    const pairs = [['', list.length ? '— inherit the chat’s connection —' : 'No connection profiles found']];
    for (const p of list) pairs.push([p.id, `${p.name}${p.model ? ` · ${p.model}` : ''}`]);

    box.append(field('Send with', dropdown(pairs, node.profileId ?? '', (v) => {
        node.profileId = v || null;
        touch();
        canvas.render();
        renderInspector();
    }), node.type === NODE_TYPES.OUTPUT
        ? 'Which connection profile answers this canvas. Its prompt post-processing handles the target model’s syntax.'
        : 'The profile carries the API, the key and the prompt post-processing for its provider.'));

    if (node.type === NODE_TYPES.GENERATE) renderModelPicker(box, node);
}

/**
 * Choose the model for one Generate block.
 *
 * SillyTavern already holds a model list per provider, so this offers the real
 * models rather than asking you to remember an id. The free-text box is there
 * because a provider can offer a model the list has not caught up with yet.
 */
function renderModelPicker(box, node) {
    const source = sourceForBlock(node);
    const fromUi = source ? modelsForSource(source) : [];
    const models = fromUi.length ? fromUi : cachedModels(source);
    const inherited = effectiveModel({ ...node, model: null });

    const wrap = el('div', 'pc-model-picker');

    if (models.length) {
        const pairs = [['', inherited ? `— same as the connection (${inherited}) —` : '— same as the connection —']];
        const seen = new Set();
        for (const m of models) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            pairs.push([m.id, m.group ? `${m.group} · ${m.label}` : m.label]);
        }
        // A model saved earlier that the list no longer offers must still show.
        if (node.model && !seen.has(node.model)) pairs.push([node.model, `${node.model} (not in the list)`]);

        wrap.append(dropdown(pairs, node.model ?? '', (v) => {
            node.model = v || null;
            touch();
            canvas.render();
            renderInspector();
        }));
    } else {
        wrap.append(el('div', 'pc-hint',
            source
                ? `SillyTavern has no model list loaded for ${source} yet. Connect to it once, or type a model id below.`
                : 'Pick a connection first, or type a model id below.'));
    }

    const load = el('div', 'pc-btn menu_button');
    load.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> ${models.length ? 'Refresh model list' : 'Load model list'}`;
    load.title = source ? `Ask ${source} what models it offers` : 'Pick a connection first';
    load.addEventListener('click', async () => {
        const before = load.innerHTML;
        load.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Asking';
        try {
            const got = await fetchModelList(node);
            toast(got.length ? `Found ${got.length} models.` : 'That provider returned no model list.',
                got.length ? 'success' : 'error');
        } catch (err) {
            toast(`Could not load the model list: ${err?.message ?? err}`, 'error');
        }
        load.innerHTML = before;
        renderInspector();
    });
    wrap.append(load);

    const manual = el('input', 'text_pole');
    manual.placeholder = 'or type a model id';
    manual.value = node.model ?? '';
    manual.addEventListener('change', () => {
        node.model = manual.value.trim() || null;
        touch();
        canvas.render();
        renderInspector();
    });
    wrap.append(manual);

    box.append(field('Model', wrap,
        node.model
            ? `This block asks ${node.model}, whatever the connection is set to.`
            : 'Leave this alone to follow the connection. Set it to run this block on a different model — a cheap fast one for a thinking pass, say.'));
}

/* ================================================================== */
/* preview                                                            */
/* ================================================================== */

let previewTimer = null;

/**
 * Keep an open preview honest. Moving a block changes the reading order, so a
 * preview still showing the old order is worse than no preview at all.
 */
export function refreshPreview() {
    const box = root?._parts?.preview;
    if (!box || !box.classList.contains('pc-preview-open')) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (isOpen()) runPreview({ keepScroll: true }); }, 180);
}

export async function runPreview({ keepScroll = false } = {}) {
    const box = root._parts.preview;
    const scroll = keepScroll ? box.scrollTop : 0;
    box.classList.add('pc-preview-open');
    if (!keepScroll) {
        box.innerHTML = '';
        box.append(el('div', 'pc-preview-head', 'Compiling…'));
    }

    let plan;
    try {
        plan = await compile(current, { dryRun: true });
    } catch (err) {
        box.innerHTML = '';
        box.append(el('div', 'pc-preview-head', 'Compile failed'));
        box.append(el('pre', 'pc-error', String(err?.stack ?? err?.message ?? err)));
        return;
    }
    lastPlan = plan;
    canvas.setTrace(plan.trace);
    renderPreview(plan);
    if (keepScroll) box.scrollTop = scroll;
}

function renderPreview(plan) {
    const box = root._parts.preview;
    box.innerHTML = '';

    const stages = plan.stages ?? [];
    const calls = stages.filter(st => !st.final).length;
    const waves = new Set(stages.filter(st => !st.final).map(st => st.wave ?? 0)).size;

    const head = el('div', 'pc-preview-head');
    const callSummary = calls
        ? `${calls} model call${calls === 1 ? '' : 's'}${calls > waves ? ` in ${waves} wave${waves === 1 ? '' : 's'}` : ''}, then `
        : '';
    head.append(el('span', '', plan.ok
        ? `${callSummary}${plan.messages.length} messages \u00b7 ${(plan.tokens ?? 0).toLocaleString()} tokens`
        : 'Nothing to send'));
    head.append(el('span', 'pc-spacer'));

    const copy = el('div', 'pc-btn menu_button');
    copy.innerHTML = '<i class="fa-solid fa-copy"></i> Copy JSON';
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(plan.messages, null, 2));
            toast('Copied.', 'success');
        } catch { toast('The browser refused clipboard access.', 'error'); }
    });

    // The preview is what a send would look like right now. The last send is
    // what one actually was. Comparing them by memory is how you end up
    // arguing with your own extension.
    const last = safe(() => globalThis.promptCanvas?.getLastRun());
    if (last && !last.dryRun) {
        const seeLast = el('div', 'pc-btn menu_button');
        seeLast.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> What was actually sent';
        seeLast.title = 'The real prompt from the last send, not a fresh compile';
        seeLast.addEventListener('click', () => renderLastSend(last));
        head.append(seeLast);
    }

    head.append(copy, mkBtn('fa-chevron-down', 'Hide preview', () => box.classList.remove('pc-preview-open')));
    box.append(head);

    if (!plan.ok) box.append(el('div', 'pc-error', plan.reason));

    const profileNotes = [];
    for (const stage of stages) {
        if (stage.final) continue;
        const info = inspectProfile(stage.profileId || null);
        profileNotes.push(...info.problems);
    }

    for (const w of [...new Set([...plan.warnings, ...profileNotes])]) {
        const warn = el('div', 'pc-warn');
        warn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(w)}`;
        box.append(warn);
    }

    const body = el('div', 'pc-preview-body');

    stages.forEach((stage, index) => {
        const card = el('div', `pc-pstage${stage.final ? ' pc-pstage-final' : ''}`);

        const title = el('div', 'pc-pstage-head');
        const n = el('span', 'pc-pstage-num', stage.final ? 'SEND' : `WAVE ${(stage.wave ?? 0) + 1}`);
        const name = el('span', 'pc-pstage-name', stage.final ? 'The reply' : stage.name);
        const meta = el('span', 'pc-pstage-meta');
        const bits = [`${stage.messages.length} message${stage.messages.length === 1 ? '' : 's'}`];
        if (stage.tokens) bits.push(`${stage.tokens.toLocaleString()} tokens`);
        if (!stage.final) {
            bits.push(profileName(stage.profileId) ?? 'same as the chat');
            const m = effectiveModel(stage.node ?? { profileId: stage.profileId });
            if (m) bits.push(m);
            bits.push(`max ${stage.maxTokens}`);
        }
        meta.textContent = bits.join(' \u00b7 ');
        title.append(n, name, el('span', 'pc-spacer'), meta);
        card.append(title);

        for (const [i, m] of stage.messages.entries()) {
            const row = el('div', `pc-msg pc-msg-${m.role}`);
            row.append(el('div', 'pc-msg-role', `${i + 1}. ${m.role}${m.name ? ` (${m.name})` : ''}`));
            row.append(el('div', 'pc-msg-text', m.content));
            card.append(row);
        }
        body.append(card);
    });

    box.append(body);

    if (plan.trace?.length) {
        const tr = el('details', 'pc-trace');
        tr.append(el('summary', '', `Block trace (${plan.trace.length})`));
        for (const t of plan.trace) {
            tr.append(el('div', `pc-trace-line pc-trace-${t.status}`,
                `${t.title} \u2014 ${t.status}${t.chars ? ` \u00b7 ${t.chars} chars` : ''} (${t.why})`));
        }
        box.append(tr);
    }
}

/**
 * The prompt from the last real send, exactly as it went out, with the
 * Generate answers that were in it. Kept in memory rather than written into
 * the chat file, which a full prompt would bloat badly.
 */
function renderLastSend(last) {
    const box = root._parts.preview;
    box.innerHTML = '';

    const head = el('div', 'pc-preview-head');
    const when = new Date(last.at);
    const chars = last.messages.reduce((n, m) => n + m.content.length, 0);
    head.append(el('span', '', `Sent ${when.toLocaleTimeString()} \u00b7 "${last.graph}" \u00b7 ${last.messages.length} messages \u00b7 ${chars.toLocaleString()} characters`));
    head.append(el('span', 'pc-spacer'));

    const copy = el('div', 'pc-btn menu_button');
    copy.innerHTML = '<i class="fa-solid fa-copy"></i> Copy JSON';
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(last.messages, null, 2));
            toast('Copied.', 'success');
        } catch { toast('The browser refused clipboard access.', 'error'); }
    });

    const back = el('div', 'pc-btn menu_button pc-primary');
    back.innerHTML = '<i class="fa-solid fa-eye"></i> Back to preview';
    back.addEventListener('click', () => runPreview());

    head.append(back, copy, mkBtn('fa-chevron-down', 'Hide', () => box.classList.remove('pc-preview-open')));
    box.append(head);

    box.append(el('div', 'pc-test-note',
        `The chat had ${last.chatLength ?? '?'} messages at the time. A preview taken now compiles against the chat as it is now, so the two differ whenever the conversation has moved on.`));

    for (const w of [...new Set(last.warnings ?? [])]) {
        const warn = el('div', 'pc-warn');
        warn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(w)}`;
        box.append(warn);
    }

    if (last.thoughts?.length) {
        const card = el('div', 'pc-pstage');
        card.append(el('div', 'pc-pstage-head', `Generate blocks that ran (${last.thoughts.length})`));
        for (const t of last.thoughts) {
            card.append(el('div', 'pc-msg-role', `${t.title}${t.failed ? ' \u2014 failed' : ''}${t.model ? ` \u00b7 ${t.model}` : ''}`));
            card.append(el('div', 'pc-msg-text', t.failed ? t.failed : (t.text || '(empty)')));
        }
        box.append(card);
    }

    const body = el('div', 'pc-preview-body');
    const card = el('div', 'pc-pstage pc-pstage-final');
    card.append(el('div', 'pc-pstage-head', 'The prompt that went out'));
    for (const [i, m] of last.messages.entries()) {
        const row = el('div', `pc-msg pc-msg-${m.role}`);
        row.append(el('div', 'pc-msg-role', `${i + 1}. ${m.role}${m.name ? ` (${m.name})` : ''}`));
        row.append(el('div', 'pc-msg-text', m.content));
        card.append(row);
    }
    body.append(card);
    box.append(body);
}

/* ================================================================== */
/* canvas-level actions                                               */
/* ================================================================== */

async function onNewGraph() {
    const name = await inputBox('Name for the new canvas');
    if (!name) return;
    current = createGraph(name);
    canvas.setGraph(current);
    renderAll();
}

async function onDuplicateGraph() {
    const name = await inputBox('Name for the copy', `${current.name} copy`);
    if (!name) return;
    current = duplicateGraph(current.id, name);
    canvas.setGraph(current);
    renderAll();
}

async function onRenameGraph() {
    const name = await inputBox('Rename canvas', current.name);
    if (!name) return;
    current.name = name;
    touch();
    renderAll();
}

async function onDeleteGraph() {
    if (!await confirmBox(`Delete the canvas "${current.name}"? This cannot be undone.`)) return;
    deleteGraph(current.id);
    current = allGraphs()[0];
    canvas.setGraph(current);
    renderAll();
}

function onExportGraph() {
    const json = exportGraph(current.id);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `${current.name.replace(/[^\w-]+/g, '_')}.canvas.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function onImportGraph() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const res = importGraph(await file.text());
        if (!res.ok) return toast(res.reason, 'error');
        current = res.graph;
        canvas.setGraph(current);
        renderAll();
        canvas.fit();
        toast(`Imported "${current.name}".`, 'success');
    });
    input.click();
}

async function onSeedFromST() {
    const count = L.stPrompts().filter(p => p.inOrder).length;
    if (!count) return toast('No chat completion prompt order found. Open a chat completion preset first.', 'error');
    if (!await confirmBox(`Replace the blocks on "${current.name}" with SillyTavern’s current prompt order (${count} prompts)?`)) return;

    const fresh = blankGraph(current.name);
    L.graphFromCurrentOrder(fresh, { NODE_TYPES, addNode, connect, outputNode, WIRE_KINDS });
    current.nodes = fresh.nodes;
    current.wires = fresh.wires;
    touch();
    canvas.setGraph(current);
    renderAll();
    canvas.fit();
    toast(`Seeded ${count} prompts.`, 'success');
}

/* ================================================================== */
/* context menu                                                       */
/* ================================================================== */

/** Copy a block and select the copy. Ctrl+D, or the block's right-click menu. */
function duplicateSelected(node, withInputs = false) {
    const copy = duplicateNode(current, node.id, { withInputs });
    if (!copy) return;
    canvas.select({ kind: 'node', id: copy.id });
    renderStatus();
    refreshPreview();
}

function onCanvasMenu({ event, node, wire, at }) {
    document.querySelector('.pc-menu')?.remove();
    const menu = el('div', 'pc-menu');
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const item = (label, icon, fn) => {
        const i = el('div', 'pc-menu-item');
        i.innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHtml(label)}`;
        i.addEventListener('click', () => { menu.remove(); fn(); });
        return i;
    };

    if (wire?.loop) {
        // A loop has no kind to change: offer what matters for a loop.
        const from = current.nodes[wire.from];
        menu.append(el('div', 'pc-menu-head', `Loop: at most ${wire.loop.max ?? 3}\u00d7`));
        for (const n of [1, 2, 3, 5, 10]) {
            if (n === (wire.loop.max ?? 3)) continue;
            menu.append(item(`At most ${n}\u00d7`, 'fa-rotate', () => { wire.loop.max = n; touch(); canvas.render(); renderInspector(); }));
        }
        if (from?.type === NODE_TYPES.GENERATE) {
            menu.append(item(wire.loop.stopWhenSame !== false ? 'Don\u2019t stop early' : 'Stop early if the answer stops changing', 'fa-hand', () => {
                wire.loop.stopWhenSame = wire.loop.stopWhenSame === false; touch(); renderInspector();
            }));
        }
        menu.append(item('Loop settings\u2026', 'fa-sliders', () => canvas.select({ kind: 'wire', id: wire.id })));
        menu.append(item('Remove this loop', 'fa-trash-can', () => { disconnect(current, wire.id); selected = null; canvas.render(); renderInspector(); }));
    } else if (wire) {
        for (const [kind, label] of Object.entries(WIRE_LABEL)) {
            menu.append(item(`Make it "${label}"`, 'fa-shuffle', () => canvas.setWireKind(wire.id, kind)));
        }
        if (wire.kind !== WIRE_KINDS.TOGETHER && !wire.loop) {
            menu.append(wire.mode === 'activate'
                ? item('Send the text again', 'fa-align-left', () => { delete wire.mode; touch(); canvas.render(); renderInspector(); })
                : item('Only switch it on (Activate)', 'fa-bolt', () => { wire.mode = 'activate'; touch(); canvas.render(); renderInspector(); }));
        }
        menu.append(item('Cut wire', 'fa-scissors', () => { disconnect(current, wire.id); canvas.render(); }));
    } else if (node) {
        if (node.type !== NODE_TYPES.OUTPUT) {
            menu.append(item('Duplicate', 'fa-clone', () => duplicateSelected(node, false)));
            menu.append(item('Duplicate with its inputs', 'fa-clone', () => duplicateSelected(node, true)));
        }
        menu.append(item(node.enabled === false ? 'Switch on' : 'Switch off', 'fa-power-off', () => {
            node.enabled = node.enabled === false;
            touch();
            canvas.render();
        }));
        if (node.type === NODE_TYPES.GENERATE) {
            const others = Object.values(current.nodes).filter(n =>
                n.type === NODE_TYPES.GENERATE && n.id !== node.id);
            const tied = togetherGroup(current, node.id);

            for (const other of others.sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
                const already = tied.has(other.id);
                menu.append(item(
                    already ? `Stop sending with "${other.title}"` : `Send at the same time as "${other.title}"`,
                    'fa-bolt',
                    () => {
                        if (already) {
                            const wire = Object.values(current.wires).find(w => w.kind === WIRE_KINDS.TOGETHER
                                && ((w.from === node.id && w.to === other.id) || (w.from === other.id && w.to === node.id)));
                            if (wire) disconnect(current, wire.id);
                            else toast('Those two are tied through another block.', 'error');
                        } else {
                            const res = connect(current, node.id, other.id, WIRE_KINDS.TOGETHER);
                            if (!res.ok) return toast(res.reason, 'error');
                        }
                        canvas.render();
                        renderInspector();
                    }));
            }
        }

        menu.append(item('Wire into Output', 'fa-arrow-right-to-bracket', () => {
            const res = connect(current, node.id, outputNode(current).id, WIRE_KINDS.MERGE);
            if (!res.ok) toast(res.reason, 'error'); else canvas.render();
        }));
        if (node.type !== NODE_TYPES.OUTPUT) {
            menu.append(item('Delete block', 'fa-trash-can', () => {
                removeNode(current, node.id);
                    selected = null;
                canvas.render();
                renderInspector();
            }));
        }
    } else {
        for (const [type, icon, label] of [
            [NODE_TYPES.PROMPT, 'fa-comment', 'Prompt'],
            [NODE_TYPES.GENERATE, 'fa-brain', 'Generate block'],
            [NODE_TYPES.DECIDER, 'fa-code-fork', 'Decider'],
            [NODE_TYPES.ST, 'fa-box-archive', 'SillyTavern prompt'],
            [NODE_TYPES.HISTORY, 'fa-clock-rotate-left', 'Chat history'],
            [NODE_TYPES.INJECTION, 'fa-syringe', 'Injection'],
            [NODE_TYPES.LOREBOOK, 'fa-book-atlas', 'Lorebook'],
            [NODE_TYPES.NOTE, 'fa-note-sticky', 'Note'],
        ]) {
            menu.append(item(`Add ${label}`, icon, () => {
                const n = addNode(current, type, Math.round(at.x), Math.round(at.y));
                canvas.select({ kind: 'node', id: n.id });
                renderAll();
            }));
        }
        menu.append(item('Fit to view', 'fa-expand', () => canvas.fit()));
    }

    document.body.append(menu);

    // Keep it on screen.
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - r.width - 8)}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 8)}px`;

    // Dismiss on a click elsewhere. The containment check is the whole fix:
    // tearing the menu down on any mousedown removed the item before its own
    // click could land, so nothing ever happened.
    const dismiss = (e) => {
        if (e?.type === 'mousedown' && menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener('mousedown', dismiss, true);
        window.removeEventListener('blur', dismiss);
        document.removeEventListener('keydown', onEsc, true);
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, true);
        window.addEventListener('blur', dismiss);
        document.addEventListener('keydown', onEsc, true);
    }, 0);
}

export function refreshIfOpen() {
    if (isOpen()) { renderStatus(); renderSidebar(); }
}

export function lastPreview() {
    return lastPlan;
}
