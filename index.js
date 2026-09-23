/**
 * Prompt Canvas — entry point.
 *
 * Wires the extension into SillyTavern and, when armed, hands the compiled
 * prompt to the generation pipeline.
 *
 * Two interception points, both officially mutable:
 *
 *   CHAT_COMPLETION_PROMPT_READY   chat completion. eventData.chat is the
 *                                  final message array. We replace it.
 *   GENERATE_AFTER_COMBINE_PROMPTS text completion. eventData.prompt is the
 *                                  final string. We flatten and replace it.
 *
 * The safety rule everywhere below: if anything at all goes wrong, leave the
 * original prompt untouched and say so. A prompt extension that throws mid
 * generation is worse than one that does nothing.
 */

import { settings, save, resolveGraph, ctx, safe } from './src/state.js?v=0.4.0';
import { run, callCount } from './src/run.js?v=0.4.0';
import * as UI from './src/ui.js?v=0.4.0';
import { renderThoughts, attachThoughts, repaintAll, livePanel } from './src/thoughts.js?v=0.4.0';

const MODULE = 'prompt-canvas';
let lastRun = null;
let busy = false;
let pendingThoughts = null;
/** Aborts the Generate blocks of the run in progress, when you press Stop. */
let currentAbort = null;

/* ------------------------------------------------------------------ */
/* generation hooks                                                    */
/* ------------------------------------------------------------------ */

function armed() {
    return !!safe(() => settings().enabled);
}

/**
 * Build the prompt for one send.
 *
 * Returns null when Prompt Canvas should keep its hands off, in which case
 * SillyTavern's own prompt goes out untouched.
 */
async function build(dryRun) {
    const { graph } = resolveGraph();
    if (!graph) return null;

    // Our own sub-calls go through ChatCompletionService, which emits no
    // events, so this guard is belt and braces rather than load-bearing.
    if (busy) {
        console.warn(`[${MODULE}] already building a prompt; letting this one through untouched`);
        return null;
    }

    busy = true;
    try {
        const calls = dryRun ? 0 : callCount(graph);
        if (calls) console.log(`[${MODULE}] "${graph.name}": ${calls} model call${calls === 1 ? '' : 's'} before the send`);

        if (calls) progress.start(graph.name, calls);
        if (!dryRun) { livePanel.clear(); pendingThoughts = null; }
        const abort = dryRun ? null : new AbortController();
        currentAbort = abort;
        const { plan, thoughts, failures, aborted, rescued, throttled } = await run(graph, {
            dryRun,
            signal: abort?.signal ?? null,
            onStage: (node) => { progress.running(node.title); safe(() => livePanel.running(node)); },
            onResult: (entry) => safe(() => livePanel.result(entry)),
        }).finally(() => { progress.done(); if (currentAbort === abort) currentAbort = null; });

        if (aborted) {
            console.log(`[${MODULE}] stopped before the send`);
            return null;
        }

        if (!plan.ok) {
            // An empty chat is a normal state, not a fault worth shouting about.
            if (plan.quiet) console.log(`[${MODULE}] ${plan.reason}`);
            else warn(`Prompt Canvas did not replace the prompt: ${plan.reason}`);
            return null;
        }

        lastRun = {
            at: Date.now(),
            graph: graph.name,
            dryRun,
            chatLength: safe(() => ctx().chat?.length) ?? 0,
            stages: plan.stages.map(st => ({ name: st.name, messages: st.messages.length, final: st.final })),
            warnings: plan.warnings,
            trace: plan.trace,
            messages: plan.messages,
            thoughts,
        };

        if (!dryRun && thoughts.some(t => t.show && (String(t.text || '').trim() || t.failed))) {
            pendingThoughts = thoughts.filter(t => t.show);
        }

        if (throttled) {
            warn(`${rescued.length === 1 ? `"${rescued[0]}" was` : `${rescued.length} Generate blocks were`} refused when sent at the same time as another block, but worked on ${rescued.length === 1 ? 'its' : 'their'} own. Your provider seems to limit simultaneous requests, so from now on independent blocks go out one at a time. Blocks you tied together still go at once \u2014 untie them if they keep failing. You can switch this back in the extension settings.`);
            safe(() => paintThrottle());
        }

        for (const f of failures ?? []) {
            warn(`"${f.title}" failed and added nothing to this prompt. ${f.error}`);
        }

        for (const w of [...new Set(plan.warnings)]) console.warn(`[${MODULE}] ${w}`);
        return plan;
    } finally {
        busy = false;
    }
}

async function onChatCompletionPromptReady(eventData) {
    if (!armed()) return;
    if (!eventData || !Array.isArray(eventData.chat)) return;
    try {
        const plan = await build(!!eventData.dryRun);
        if (!plan) return;
        eventData.chat.length = 0;
        eventData.chat.push(...plan.messages);
        console.log(`[${MODULE}] sent ${plan.messages.length} messages`);
    } catch (err) {
        console.error(`[${MODULE}] compile failed, leaving the prompt alone`, err);
        warn('Prompt Canvas hit an error and left SillyTavern\u2019s prompt untouched. See the console.');
    }
}

async function onTextCompletionPromptReady(eventData) {
    if (!armed()) return;
    if (!eventData || typeof eventData.prompt !== 'string') return;
    // SillyTavern fires this event for chat completion too, just before
    // CHAT_COMPLETION_PROMPT_READY, and then throws the string away. Building
    // here as well ran every Generate block twice per send — billed twice, and
    // the first run's answers vanished from the chat when the second began.
    if (safe(() => ctx().mainApi) === 'openai') return;
    try {
        const plan = await build(!!eventData.dryRun);
        if (!plan) return;
        // Text completion has no roles, so blocks are flattened in order.
        eventData.prompt = plan.messages.map(m => m.content).join('\n\n');
    } catch (err) {
        console.error(`[${MODULE}] compile failed, leaving the prompt alone`, err);
    }
}

/**
 * Hand the Generate blocks' answers to the message they produced, so they can
 * be folded away under the reply instead of living only in a console log.
 */
function onMessageReceived(messageId) {
    safe(() => livePanel.clear());
    if (!pendingThoughts) return;
    const thoughts = pendingThoughts;
    pendingThoughts = null;
    safe(() => attachThoughts(messageId, thoughts));
}

/**
 * Stop pressed. Cancel any Generate blocks still running so they stop being
 * billed, and keep whatever answers already came back on screen.
 */
function onGenerationStopped() {
    if (currentAbort && !currentAbort.signal.aborted) {
        currentAbort.abort(new Error('Stopped'));
        console.log(`[${MODULE}] Generate blocks cancelled`);
    }
    pendingThoughts = null;
    safe(() => livePanel.dropPending());
}

/**
 * One small pill in the corner while the Generate blocks run, instead of a
 * stack of toasts counting to a number that means nothing. It says what is
 * being asked right now and gets out of the way when the run is over.
 */
const progress = (() => {
    let box = null;
    let list = null;
    let running = new Set();
    let finished = 0;
    let total = 0;

    const ensure = () => {
        if (box) return box;
        box = document.createElement('div');
        box.className = 'pc-progress';
        box.innerHTML = '<div class="pc-progress-head"></div><div class="pc-progress-list"></div>';
        list = box.querySelector('.pc-progress-list');
        document.body.append(box);
        return box;
    };

    const paint = () => {
        if (!box) return;
        box.querySelector('.pc-progress-head').textContent =
            `Prompt Canvas \u00b7 ${Math.min(finished + running.size, total)} of ${total}`;
        list.innerHTML = '';
        for (const title of running) {
            const row = document.createElement('div');
            row.className = 'pc-progress-row';
            row.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${title}`;
            list.append(row);
        }
    };

    return {
        start(graphName, count) {
            total = count;
            finished = 0;
            running = new Set();
            ensure().classList.add('pc-progress-on');
            paint();
        },
        running(title) {
            if (!box) return;
            running.add(title);
            paint();
            // A block is only ever "running" until the next paint; the set is
            // trimmed as later blocks report in, which keeps this honest
            // without threading completion callbacks through the executor.
            setTimeout(() => { if (running.has(title)) { running.delete(title); finished++; paint(); } }, 60000);
        },
        done() {
            if (!box) return;
            running.clear();
            box.classList.remove('pc-progress-on');
            setTimeout(() => { box?.remove(); box = null; list = null; }, 400);
        },
    };
})();

function warn(message) {
    console.warn(`[${MODULE}] ${message}`);
    safe(() => globalThis.toastr?.warning(message, 'Prompt Canvas'));
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function addLauncher() {
    // Extensions menu entry
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('pc-menu-launch')) {
        const item = document.createElement('div');
        item.id = 'pc-menu-launch';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<i class="fa-solid fa-diagram-project"></i><span>Prompt Canvas</span>';
        item.addEventListener('click', () => UI.open());
        menu.append(item);
    }

    // Settings panel
    const host = document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
    if (host && !document.getElementById('pc-settings')) {
        const block = document.createElement('div');
        block.id = 'pc-settings';
        block.className = 'pc-settings-block';
        block.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Canvas</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="pc-enabled">
                        <input id="pc-enabled" type="checkbox">
                        <span>Arm the canvas (it builds the prompt instead of SillyTavern)</span>
                    </label>
                    <div class="pc-settings-hint">
                        While this is off SillyTavern behaves exactly as it always has.
                    </div>
                    <div id="pc-throttled" class="pc-settings-hint pc-throttled" hidden>
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        Generate blocks are being sent one at a time, because your provider
                        refused several at once.
                        <a id="pc-unthrottle" href="javascript:void(0)">Try sending them together again</a>
                    </div>
                    <label class="checkbox_label" for="pc-sendbar-opt">
                        <input id="pc-sendbar-opt" type="checkbox">
                        <span>Show a Prompt Canvas button next to Send</span>
                    </label>
                    <div class="pc-settings-hint">
                        Tinted while the canvas is armed. Click to open, right-click to arm or disarm.
                    </div>
                    <div id="pc-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-diagram-project"></i><span>Open canvas</span>
                    </div>
                </div>
            </div>`;
        host.append(block);

        const cb = block.querySelector('#pc-enabled');
        cb.checked = armed();
        cb.addEventListener('change', () => {
            settings().enabled = cb.checked;
            save();
            UI.refreshIfOpen();
            paintSendbar();
        });
        const sbo = block.querySelector('#pc-sendbar-opt');
        sbo.checked = sendbarEnabled();
        sbo.addEventListener('change', () => {
            settings().ui ??= {};
            settings().ui.sendbarButton = sbo.checked;
            save();
            addSendbarButton();
        });
        paintThrottle();
        block.querySelector('#pc-unthrottle').addEventListener('click', () => {
            settings().concurrency = 2;
            save();
            paintThrottle();
            safe(() => globalThis.toastr?.info('Independent Generate blocks will go out together again.', 'Silly Canvas'));
        });

        block.querySelector('#pc-open-btn').addEventListener('click', () => UI.open());
    }
}

/**
 * A button on the chat bar, next to Send. It carries state as well as opening
 * the panel: tinted while the canvas is armed, plain while it is not, and the
 * tooltip names the canvas that would actually run. Right-click arms or
 * disarms it without opening anything.
 */
function sendbarEnabled() {
    return safe(() => settings().ui?.sendbarButton) !== false;
}

function addSendbarButton() {
    const bar = document.getElementById('rightSendForm');
    const existing = document.getElementById('pc-sendbar');
    if (!sendbarEnabled()) { existing?.remove(); return true; }
    if (!bar) return false;
    if (existing) { paintSendbar(); return true; }

    const b = document.createElement('div');
    b.id = 'pc-sendbar';
    b.className = 'fa-solid fa-diagram-project interactable';
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.addEventListener('click', () => UI.open());
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); UI.open(); } });
    b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        settings().enabled = !armed();
        save();
        UI.refreshIfOpen();
        paintSendbar();
        safe(() => globalThis.toastr?.info(armed()
            ? 'Armed. Your canvas builds the prompt.'
            : 'Off. SillyTavern builds the prompt as usual.', 'Prompt Canvas'));
    });
    b.addEventListener('mouseenter', paintSendbar);

    const send = document.getElementById('send_but');
    if (send && send.parentElement === bar) bar.insertBefore(b, send);
    else bar.append(b);
    paintSendbar();
    return true;
}

function paintSendbar() {
    const b = document.getElementById('pc-sendbar');
    if (!b) return;
    const on = armed();
    const r = safe(() => resolveGraph()) ?? { graph: null, source: 'none' };
    const from = { chat: 'pinned to this chat', character: 'pinned to this character', default: 'the default canvas' }[r.source];
    b.classList.toggle('pc-sendbar-on', on && !!r.graph);
    b.classList.toggle('pc-sendbar-nograph', on && !r.graph);
    b.title = !on
        ? 'Prompt Canvas is off — SillyTavern builds the prompt.\nClick to open. Right-click to arm.'
        : r.graph
            ? `Prompt Canvas is armed: "${r.graph.name}" (${from}) builds the prompt.\nClick to open. Right-click to switch off.`
            : 'Prompt Canvas is armed but no canvas applies here, so SillyTavern builds the prompt.\nClick to open. Right-click to switch off.';
}

function paintThrottle() {
    const box = document.getElementById('pc-throttled');
    if (box) box.hidden = !(Number(safe(() => settings().concurrency)) === 1);
}

/**
 * SillyTavern builds the wand menu from a template after extensions load, so
 * the menu may not exist yet. Retry briefly rather than losing the entry.
 */
function mountLauncher() {
    let tries = 0;
    const tick = () => {
        addLauncher();
        const bar = addSendbarButton();
        const done = bar && document.getElementById('pc-menu-launch') && document.getElementById('pc-settings');
        if (!done && tries++ < 40) setTimeout(tick, 250);
    };
    tick();
}

function addSlashCommand() {
    const c = ctx();
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'canvas',
            helpString: 'Open Prompt Canvas, or arm/disarm it: <code>/canvas arm</code>, <code>/canvas off</code>.',
            unnamedArgumentList: [],
            callback: (_args, value) => {
                const v = String(value ?? '').trim().toLowerCase();
                if (v === 'arm' || v === 'on') { settings().enabled = true; save(); UI.refreshIfOpen(); paintSendbar(); return 'armed'; }
                if (v === 'off' || v === 'disarm') { settings().enabled = false; save(); UI.refreshIfOpen(); paintSendbar(); return 'off'; }
                UI.toggle();
                return '';
            },
        }));
    } catch (err) {
        console.warn(`[${MODULE}] slash command not registered`, err);
    }
}

export function getLastRun() {
    return lastRun;
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

(function boot() {
    const start = () => {
        try {
            const c = ctx();
            settings();

            c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
            c.eventSource.on(c.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, onTextCompletionPromptReady);
            c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            c.eventSource.on(c.eventTypes.GENERATION_STOPPED, onGenerationStopped);
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => safe(() => renderThoughts(id)));
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { safe(() => livePanel.clear()); UI.refreshIfOpen(); safe(() => repaintAll()); paintSendbar(); });
            document.addEventListener('pc-state', () => { paintSendbar(); const cb = document.getElementById('pc-enabled'); if (cb) cb.checked = armed(); });

            mountLauncher();
            addSlashCommand();

            globalThis.promptCanvas = { open: UI.open, close: UI.close, toggle: UI.toggle, getLastRun };
            console.log(`[${MODULE}] ready`);
        } catch (err) {
            console.error(`[${MODULE}] failed to start`, err);
        }
    };

    if (globalThis.SillyTavern?.getContext) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
