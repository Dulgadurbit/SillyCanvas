# Prompt Canvas — handoff

Everything someone needs to pick this up cold: what it is, how it is built, why
it is built that way, and the traps that have already cost a debugging session.

- **Author:** Hanno
- **Built against:** SillyTavern 1.19.0, on Windows at `C:\SillyTavern-New\SillyTavern`
- **Lives at:** `public/scripts/extensions/third-party/prompt-canvas/`
- **Companion doc:** `ROADMAP.md` in the same folder — everything not yet built
- **Status:** working and in daily use; not yet published to a repo

---

## 1. What it is

A node canvas for SillyTavern prompts. Blocks are prompts; wires say how they
combine; the whole graph compiles into the message array that leaves the
machine, which you can read in full before a single token is spent.

It replaces SillyTavern's prompt assembly when armed, and does nothing at all
when not.

The design rule the whole thing rests on: **a graph is not executed, it is
compiled into a plan, and the plan is what runs.** A plan is inspectable before
anything is spent, and a graph that compiles to nothing fails loudly on the
canvas instead of quietly sending a broken prompt.

The second rule: **reading order is vertical.** Where two blocks feed the same
target, the one higher on the canvas goes in first. No exceptions, because a
graph you have to trace to predict is not a tool.

---

## 2. Files

~5,900 lines total.

| file | lines | what it owns |
|---|---|---|
| `index.js` | 353 | boot, the two generation hooks, the progress pill, settings drawer, `/canvas` |
| `src/state.js` | 500 | settings, graphs, nodes, wires, bindings, import/export |
| `src/compile.js` | 804 | the compiler: context gathering, conditions, the graph walk, waves |
| `src/run.js` | 641 | the executor: model calls, profiles, models, failure handling |
| `src/canvas.js` | 688 | the canvas renderer (SVG + DOM, hand-rolled) |
| `src/ui.js` | 1845 | the panel: library, inspector, preview, all the controls |
| `src/thoughts.js` | 125 | a Generate block's answer folded under the chat message |
| `src/library.js` | 215 | the prompt library and the read-through SillyTavern folder |
| `style.css` | 693 | everything visual |

`manifest.json` loads `index.js` as an ES module; the `src/*.js` imports are
plain relative imports and need no build step.

---

## 3. Architecture

### The flow

```
  arm switch on?
        │
        ▼
  CHAT_COMPLETION_PROMPT_READY  (or GENERATE_AFTER_COMBINE_PROMPTS)
        │
        ▼
  resolveGraph()       chat pin > character pin > default canvas
        │
        ▼
  run(graph)           ── generateLevels() → waves of Generate blocks
        │                  each wave: collect() its prompt → askModel() → keep answer
        ▼
  compile(graph, {results})
        │                  collect() walks back from Output with the answers in place
        ▼
  eventData.chat.length = 0; push(plan.messages)
```

### Node types

`PROMPT` · `ST` · `HISTORY` · `INJECTION` · `GENERATE` · `OUTPUT` · `NOTE`

- **PROMPT** — your own text and role.
- **ST** — a proxy for one of SillyTavern's own prompts, read live from
  `oai_settings.prompts`. Can be overridden per canvas without touching the
  preset, and written back to the preset on request.
- **HISTORY** — the chat, as alternating turns or as continuous prose.
- **INJECTION** — World Info, Author's Note, summary, vectors.
- **GENERATE** — a model call in the middle of the graph.
- **OUTPUT** — the final send. Exactly one per canvas, undeletable.
- **NOTE** — for you. Never sent.

### Wire kinds

- `merge` — the upstream block stays its own message, placed before this one.
- `append` / `prepend` — the upstream text is folded into this block's message.
- `together` — **not a data wire.** Ties two Generate blocks so they go out at
  the same time. Carries nothing; `wiresInto`/`wiresOutOf` filter it out so the
  data logic never sees it.
- `sequence` — dead. Migrated to `merge` on load by `migrateGraph()`.

### The Generate barrier

The single most important semantic. A Generate block is a wall:

- everything wired into its **top** is the question,
- its answer leaves the **bottom**,
- the blocks feeding it **never reach the final prompt** — only its answer does.

In `collect()`, a Generate node that is not the assembly target returns only its
answer and never recurses into its inputs. This is what makes a thinking pass
work: the brief and history that produced the plan stay behind, and the reply
gets the plan.

### Waves

`generateLevels()` groups Generate blocks into waves. Everything in a wave is
independent, so it goes out at once; each wave waits for the one before.
A `together` tie forces its members into the same wave and into one batch, even
past the concurrency limit, because an explicit tie outranks a default.

---

## 4. Where the data lives

```
extensionSettings['prompt-canvas'] = {
  enabled,            // the arm switch
  parallel,           // automatic parallel sending (ties ignore this)
  concurrency,        // default 2
  activeGraphId,      // the default canvas
  graphs: { [id]: Graph },
  library: { folders: [], prompts: [] },
  modelCache: { [source]: [{id,label}] },
  ui: { collapsedFolders: [] },
}
```

Bindings live **outside** that object on purpose:

- a **chat** pins a graph through `chat_metadata.promptCanvasGraph`, so it
  travels with the chat;
- a **character** pins one through its extension field, so it travels with the
  card when exported.

Resolution: chat > character > default.

---

## 5. The decisions worth knowing, and why

**Everything goes through `SillyTavern.getContext()`.** No deep imports into ST
internals. This is why the extension has survived every change so far and it is
worth more than any single feature.

**Hand-rolled canvas, no graph library.** A library means a bundler or a CDN
dependency, and neither survives a SillyTavern update gracefully. Hand-rolled
also inherits the user's theme instead of fighting it.

**A failed Generate block contributes nothing.** An earlier version pasted
`[Generate failed: ...]` into the prompt that actually went out. Never do that.

**Dry runs never call a model.** SillyTavern fires dry runs to count tokens.
The guard is at the top of `run()`.

**We warn, we do not silently repair the user's config.** A connection profile
pointing at a missing preset is reported, not substituted. A profile with no
model *is* filled in, because otherwise the request is simply rejected — the
line is between "this cannot work at all" and "this is your choice to make".

---

## 6. Traps already paid for

Each of these cost real debugging time. They are all handled; do not regress
them.

**A prompt with nothing to answer.** A thinking pass is naturally all system
messages, and `merge` post-processing squashes them into one system message
with no user turn. OpenRouter, Gemini and Claude all reject that. `shapeForApi()`
promotes the last message to `user` when nothing is a user or assistant turn.

**A connection profile with no model.** Profiles can carry `exclude: ["model"]`
so they follow the chat. A normal send fills that in; a Generate block going
through the profile directly does not, and the provider answers a bare
`Bad Request` with no explanation. `inspectProfile()` fills it from
`getChatCompletionModel()`.

**Reasoning tokens eat the budget.** Measured on Gemini 3.8 Flash via
OpenRouter with `max_tokens: 500`: 476 tokens of hidden thinking, 20 left for
the reply, `finish_reason: length`, 79 characters of an answer that started
mid-sentence. Generate blocks default to thinking **off**. Same prompt with it
off: 0 thinking tokens, 3,059 characters.

**`reasoning_effort: 'none'` is rejected by Gemini through OpenRouter**, even
though it is what SillyTavern sends for its own minimum. `'minimal'` is accepted
and measurably works. There is a fallback that retries without the setting for
the next provider that disagrees.

**Errors arrive wrapped.** SillyTavern throws
`new Error('API request failed', { cause })`. Reading `.message` tells you
nothing. `describeError()` walks the cause chain.

**Some providers refuse concurrent requests.** If a block fails inside a
parallel wave it is retried on its own before being given up on.

**CSS class collisions.** `.pc-stage` was once both the layout column and the
preview cards; the cards inherited `position: relative` and painted over the
sticky header. Preview cards are `.pc-pstage` now.

**`inset: 0` is not enough.** SillyTavern's layout can leave a fixed child with
a zero-height containing block, which collapsed the whole panel while its header
overflowed onto the chat. The panel is sized in viewport units.

**Z-index.** Other extensions sit as high as 31000. The panel is 31500.

**The context menu.** Tearing it down on any `mousedown` removes the item before
its own click can land, so nothing ever happens. Dismiss only on a click
*outside* it.

---

## 7. How to work on it

**No build step.** Edit the files, hard-reload SillyTavern. Note that ES modules
cache aggressively — a plain reload can serve stale code. (`ROADMAP.md` §7 has
the cache-busting fix that must happen before this ships.)

**Headless tests.** There are scratch harnesses that mock
`globalThis.SillyTavern.getContext()` and import the modules directly under
node. They cover the graph walk, waves, ties, `shapeForApi()`, failure paths,
prose history and export/import. They should move into `tests/` in the repo.
`compile.js`, `state.js`, `run.js` and `library.js` are all testable this way;
`ui.js` and `canvas.js` need a DOM.

**Debugging a real send.** In the browser console:

```js
// what would go out right now, without sending
const C = await import('/scripts/extensions/third-party/prompt-canvas/src/compile.js');
const S = await import('/scripts/extensions/third-party/prompt-canvas/src/state.js');
await C.compile(S.resolveGraph().graph, { dryRun: true });

// what actually went out last time
window.promptCanvas.getLastRun();
```

Or in the UI: **Preview prompt** for what a send would look like now,
**What was actually sent** for what the last one was, and **Test this block**
on a Generate block for one real request with its reply, its token usage, and
why it stopped.

**Intercepting the wire** is sometimes the only way to settle a question. Wrap
`window.fetch`, filter for `chat-completions/generate`, and read the request
body and response. That is how the missing-model and reasoning-token bugs were
found — both were invisible from the extension's own vantage point.

---

## 8. Known-good behaviours to protect

Measured, not assumed. If a change breaks one of these, the change is wrong.

- Disarmed, SillyTavern's prompt passes through untouched.
- Armed, the canvas array replaces it completely; nothing of SillyTavern's
  assembly leaks in.
- Two independent Generate blocks overlap: both started at t=2ms, overlapped
  1.7s, 2.06s wall clock against 3.78s of request time.
- A `together` tie sends its blocks at once even with parallel switched off.
- Per-block models reach the API: two tied blocks went out simultaneously on
  `claude-haiku-4.5` and `gemini-3.8-flash`.
- A Generate block's inputs never appear in the final prompt.
- A disabled or unwired Generate block costs nothing.
- Cycles, self-wires and duplicate wires are refused with a readable reason.

---

## 9. Current state

Built and working: the canvas, seven block types, three wire kinds plus ties,
conditions, the library with the live SillyTavern folder, named canvases with
chat and character pins, the arm switch, Generate blocks with per-block models
and thinking control, parallel waves, the preview, the last-send view, per-block
preview and test, and the folded answer under each reply.

Not built: see `ROADMAP.md`. The headline items are touch support (the canvas
is mouse-only, which makes it unusable on a phone), undo/redo, a decider block,
nested groups, and the Git repository with its cache-busting fix.

The one thing to do before anything else is the repo — the extension currently
exists in exactly one place, on one machine.
