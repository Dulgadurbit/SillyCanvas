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

import { settings, save, resolveGraph, ctx, safe } from './src/state.js';
import { run, callCount } from './src/run.js';
import * as UI from './src/ui.js';
import { renderThoughts, attachThoughts, repaintAll } from './src/thoughts.js';

const MODULE = 'prompt-canvas';
let lastRun = null;
let busy = false;
let pendingThoughts = null;

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
        const { plan, thoughts, failures } = await run(graph, {
            dryRun,
            onStage: (node) => progress.running(node.title),
        }).finally(() => progress.done());

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
    if (!pendingThoughts) return;
    const thoughts = pendingThoughts;
    pendingThoughts = null;
    safe(() => attachThoughts(messageId, thoughts));
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
                    <label class="checkbox_label" for="pc-parallel">
                        <input id="pc-parallel" type="checkbox">
                        <span>Send independent Generate blocks at the same time</span>
                    </label>
                    <div class="pc-settings-hint">
                        Faster when a canvas has several Generate blocks that do not feed each
                        other. If one fails, it is tried again on its own before giving up.
                    </div>
                    <label for="pc-concurrency">How many at once</label>
                    <input id="pc-concurrency" class="text_pole" type="number" min="1" max="8">
                    <div class="pc-settings-hint">
                        Lower this if your provider or proxy refuses concurrent requests.
                        Two is a safe starting point.
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
        });
        const conc = block.querySelector('#pc-concurrency');
        conc.value = safe(() => settings().concurrency) ?? 2;
        conc.addEventListener('change', () => {
            settings().concurrency = Math.max(1, Math.min(8, Number(conc.value) || 2));
            conc.value = settings().concurrency;
            save();
        });

        const par = block.querySelector('#pc-parallel');
        par.checked = safe(() => settings().parallel) !== false;
        par.addEventListener('change', () => { settings().parallel = par.checked; save(); });

        block.querySelector('#pc-open-btn').addEventListener('click', () => UI.open());
    }
}

/**
 * SillyTavern builds the wand menu from a template after extensions load, so
 * the menu may not exist yet. Retry briefly rather than losing the entry.
 */
function mountLauncher() {
    let tries = 0;
    const tick = () => {
        addLauncher();
        const done = document.getElementById('pc-menu-launch') && document.getElementById('pc-settings');
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
                if (v === 'arm' || v === 'on') { settings().enabled = true; save(); UI.refreshIfOpen(); return 'armed'; }
                if (v === 'off' || v === 'disarm') { settings().enabled = false; save(); UI.refreshIfOpen(); return 'off'; }
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
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => safe(() => renderThoughts(id)));
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { UI.refreshIfOpen(); safe(() => repaintAll()); });

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
