# Prompt Canvas — notes for future implementation

Three things we have agreed are worth building but have not built. Each section
says what happens today, what to build, where the code lives, and the traps
already discovered the hard way — several of these cost a debugging session the
first time round and should not cost one again.

Written against SillyTavern 1.19.0 and Prompt Canvas as of this session.

---

## 1. Appended messages: one text, or roles preserved

### What happens today

Roles are always preserved. `collect()` in `src/compile.js` walks the graph and
emits one message per contributing block, each keeping its own role:

```
[system]    Main prompt
[system]    Char description
[user]      He pushed open the door.
[assistant] "You are late."
[system]    Jailbreak
```

The only way to merge anything is per-wire: `append` and `prepend` fold an
upstream block's *text* into the downstream block's message. There is no way to
say "flatten this whole branch into one message".

`shapeForApi()` in `src/run.js` then promotes the last message to `user` if
nothing is a user or assistant turn, because providers reject a prompt with
nothing to answer.

### What to build

An **assembly mode** on the Output block and on each Generate block:

- **Keep roles** (current, default) — one message per block.
- **One message** — everything flattened into a single message.

Fields when flattened:

| field | purpose | sensible default |
|---|---|---|
| `assembly` | `'roles'` \| `'single'` | `'roles'` |
| `singleRole` | role of the one message | `'user'` |
| `joiner` | between blocks | `'\n\n'` |
| `labelSpeakers` | prefix history turns with names | `false` |

`singleRole` should default to `user`, not `system`: a lone system message is
exactly the shape providers reject, and flattening is the most likely way to
produce one by accident.

### Where to touch

- `src/state.js` — add the fields to `defaultNode()` for `OUTPUT` and `GENERATE`.
- `src/compile.js` — a `flatten(messages, node)` applied to the result of
  `collect()`, inside `compile()` for the final stage and wherever a Generate
  block's prompt is assembled. Do it **before** `shapeForApi()`, never after.
- `src/ui.js` — the control in `renderGenerateFields()` and in the Output branch
  of `renderNodeInspector()`.
- `src/canvas.js` — say so on the node body; "one message" is a big enough
  change to the outgoing prompt that it should be visible without clicking.

### Traps

- **Do not reach for `custom_prompt_post_processing: 'single'` instead.** It
  does roughly this server-side, but it also rewrites names and roles in ways
  we do not control, and it is a per-request setting that the connection
  profile already owns. Doing it ourselves keeps the preview honest: what the
  preview shows is what goes out.
- **History blocks in `turns` mode lose their structure** when flattened, which
  is usually the point, but warn: the user/assistant alternation is the only
  thing telling the model who said what. Suggest the history block's own
  `prose` mode instead, which was built for exactly this and keeps speaker
  labels optional.
- **Interaction with `shapeForApi()`**: flatten first, then shape. Flattening
  to one `system` message and then having the shaper silently relabel it `user`
  would be two transformations fighting over the same decision.
- The preview must show the flattened result, not the pre-flatten list.

---

## 2. Streaming Generate blocks into the chat as they run

### What happens today

Generate blocks run inside the `CHAT_COMPLETION_PROMPT_READY` handler, which
SillyTavern **awaits before it creates the assistant message**. So while the
blocks are running there is no message in the chat to stream into. You get the
progress pill in the corner, and the finished answers are folded under the
reply afterwards by `src/thoughts.js` on `MESSAGE_RECEIVED`.

Requests are non-streaming (`stream: false`) and read with `extractData: false`
so `readReply()` can pull out `usage` and `finish_reason`.

### What to build

Live output for each running block, visible in the main chat rather than only
in the corner.

**Streaming is available**: `ConnectionManagerRequestService.sendRequest(...,
{ stream: true })` returns a function that creates an async generator. Each
yielded chunk is `{ text, swipes, state }` where `text` is **cumulative**, not
a delta.

```js
const makeStream = await ctx().ConnectionManagerRequestService.sendRequest(
    profileId, messages, maxTokens, { stream: true, signal }, override);
for await (const chunk of makeStream()) {
    panel.update(node.id, chunk.text);   // chunk.text is the whole reply so far
}
```

### Where to put the output

Not in `chat[]`. A temporary message in the chat array gets picked up by the
next prompt build, saved to the chat file, and has to be cleaned up on abort —
three ways to corrupt a chat for a cosmetic gain.

Instead: a DOM-only panel appended to `#chat`, one `<details>` per running
block, reusing the existing `.pc-thought` markup so the live view and the
folded-away view are the same thing. When the run finishes, hand the text to
`attachThoughts()` and remove the panel. The user sees one element that fills
in and then settles under the reply.

### Traps

- **Cumulative, not delta.** Appending each chunk gives you the reply repeated
  n times, growing quadratically. Assign, do not concatenate.
- **Streaming loses the token accounting.** `usage` and `finish_reason` are what
  diagnosed the truncation bug (476 of 496 tokens spent on hidden thinking).
  Streaming chunks may not carry them. Either keep non-streaming for blocks
  where the numbers matter, or accept that a streamed block cannot explain why
  it stopped — and say which in the UI rather than silently dropping the
  diagnosis.
- **Parallel waves mean several streams at once.** The panel needs to show two
  or three blocks filling in simultaneously. Do not assume one active stream.
- **Aborting.** `signal` is already plumbed through `run()` and `askModel()` but
  nothing listens to `GENERATION_STOPPED` yet. Wire that up in the same change,
  or a stopped generation leaves blocks running and billing.
- **Dry runs must still never call a model.** The guard is in `run()`; keep any
  streaming path behind it.
- Re-entrancy: the `busy` flag in `index.js` exists so a nested prompt build
  cannot recurse. Streaming makes the window longer, so it matters more.

---

## 3. Optimizations

None of these are urgent. They are listed in the order I would do them, worst
first, and all of them were observed while building rather than guessed at.

### The canvas rebuilds everything, on every keystroke

`Canvas.render()` calls `#drawNodes()`, which throws away every node element and
recreates it. The inspector calls `canvas.render()` from `input` handlers, so
typing one character into a prompt rebuilds the entire graph's DOM. On a
12-block canvas that is very visible.

- Patch the changed node in place instead of rebuilding all of them.
- Or debounce the inspector's `canvas.render()` to ~120ms; typing only affects
  that one node's preview text.

### Wire drawing forces a layout per wire

`#portPos()` reads `el.offsetHeight` for each end of each wire, and
`#drawWires()` runs on every mousemove during a drag. That is a forced
synchronous layout per wire per frame.

- Measure every node once per render pass into a `Map`, then draw.
- Reuse `<path>` elements rather than `svg.innerHTML = ''` each time.

### The model dropdown builds 445 options on every inspector render

Now that `fetchModelList()` caches 444 OpenRouter models, `renderModelPicker()`
constructs the whole `<select>` every time the inspector redraws — and the
inspector redraws on several `input` handlers.

- Build the `<option>` list once per source and clone it, or switch to an
  `<input list=...>` with a `<datalist>`.

### World info is rescanned on every compile

`gatherContext()` calls `getWorldInfoPrompt()`, a full scan, on every compile —
including every dry run SillyTavern fires for token counting.

- Cache keyed on `(chat.length, last message id, character id)` with a short
  TTL. Invalidate on `CHAT_CHANGED` and `WORLD_INFO_ACTIVATED`.
- `liveCache` in `src/ui.js` already does this for the inspector's benefit;
  the compiler should share the same cache rather than keeping its own.

### `collect()` clones every intermediate result

`structuredClone` on memo read and write. With a whole-chat history block the
cloned array is large and it is cloned once per downstream consumer.

- Only clone when a node genuinely feeds more than one target (that case is
  already detected for the duplicate-content warning).

### Token counting runs over the whole prompt every compile

`countTokens()` awaits SillyTavern's tokenizer on the full assembled text.

- Cache by a cheap hash of the text; the prompt rarely changes between the dry
  run and the real send.

### The preview holds the entire prompt in the DOM

`.pc-msg-text` renders every message in full. A long chat is megabytes of text
nodes.

- Truncate each message with a "show all" affordance, or virtualize the list.

### The sidebar rebuilds when the graph changes

`renderAll()` calls `renderSidebar()`, so adding or dragging a block rebuilds
the whole library list, including the SillyTavern folder which re-reads
`oai_settings.prompts` each time.

- Split `renderAll()` so graph changes do not touch the library.

---

## 4. Bug hunting — what is actually untested

The compiler is well covered. The interface is barely covered at all. An honest
account of where the risk sits:

**Tested, with harnesses** (currently in a scratch directory; they should move
into `tests/` in the repo so they ship with the extension): the graph walk,
wave grouping, ties, cycle and duplicate refusal, `shapeForApi()`, failure and
retry paths, prose history, export/import round-trip, the barrier property (a
Generate block's inputs never reaching the final prompt).

**Untested, and each one is a plausible bug:**

- **Touch. The canvas is mouse-only.** `canvas.js` binds `mousedown`,
  `mousemove`, `mouseup` and nothing else. On a phone or tablet you cannot pan,
  drag a block, or draw a wire. This is the largest single gap — pointer events
  would fix all of it in one change.
- **No undo.** Deleting a block writes to settings immediately. There is no way
  back except reloading before the debounced save lands, which is luck, not a
  feature. An undo stack of the last ~20 graph mutations would be cheap.
- **Group chats.** Never tried. `name1`/`name2` and the character-card fields
  behave differently with a group selected, and `getCharacterCardFields()` has a
  group path we have never exercised.
- **Text-completion profiles end to end.** `ConnectionManagerRequestService`
  handles `mode: 'tc'` by flattening messages through an instruct template. The
  code path is wired but has never actually run.
- **Swipes and regenerate.** Each swipe re-enters the prompt build, so Generate
  blocks re-run and are billed again. Is that what you want? Probably sometimes.
  There is currently no caching and no choice.
- **Streaming the main reply** while Generate blocks have already run. The
  blocks finish before the send, so it should be fine, but "should be" is doing
  a lot of work in that sentence.
- **Character binding.** `writeExtensionField()` writes into the card. Untested
  against card export/import and against a card that already has extension data
  from another extension.
- **Very large graphs.** Nothing has been tried past ~15 blocks.
- **Two canvases pinned to different chats**, switched rapidly. The resolution
  order is tested in isolation, not under chat switching.

**Worth building for its own sake:** a self-check that walks the active canvas
and reports everything suspicious in one place — stranded blocks, profiles with
missing models or presets, blocks with no text, token budgets over the context
limit, ties that contradict a data path. Most of these checks already exist
scattered across `compile()` and `inspectProfile()`; gathering them into one
"check this canvas" button would surface problems before a send rather than
during one.

---

## 5. Colour schemes

Today the panel borrows SillyTavern's theme variables for surfaces
(`--SmartThemeBlurTintColor`, `--SmartThemeBorderColor`, `--SmartThemeBodyColor`)
but every *semantic* colour is a hardcoded hex in `style.css`:

| meaning | current |
|---|---|
| merge wire, output, selection | `#7ab7ff` |
| append wire, "went in" | `#7fd18c` |
| prepend wire, warnings, overrides | `#f0c36a` |
| Generate blocks, ties, thought blocks | `#d48fe0` |
| errors, empty blocks | `#e08f8f` |

Two problems with that:

1. **Light themes are untested and probably broken.** The panel background
   follows the theme, so on a light theme it goes light — while those five
   colours stay tuned for a dark background. Nobody has looked at it.
2. **Colour is currently the only channel** for several distinctions. Wire kind
   is colour alone except for `together`, which also dashes. Trace status is
   colour alone. That is a poor deal for anyone with colour vision deficiency.

The work:

- Move all five to CSS custom properties on `.pc-root`
  (`--pc-flow`, `--pc-append`, `--pc-warn`, `--pc-generate`, `--pc-error`), so a
  scheme is a five-line override rather than a search through the stylesheet.
- Ship two or three schemes and a picker in the settings drawer; store the
  choice in `settings().ui`.
- Add a light-theme pass, triggered by measuring the panel's resolved
  background rather than guessing from the theme name.
- Give every colour-carried distinction a second channel: dash patterns for
  wire kinds, an icon or glyph for trace status.

---

## 6. A button on the chat bar

Three ways in today — the wand menu, the Extensions settings drawer, and
`/canvas`. None of them is one click from the place you are actually typing.

SillyTavern's send bar is `#send_form > #nonQRFormItems`, holding
`#leftSendForm` (the hamburger, `#options_button`), the textarea, and
`#rightSendForm` (the stscript play/pause/stop buttons and send). A button
belongs in `#rightSendForm`, styled like the stscript buttons so it looks
native rather than bolted on.

It should carry state, not just open the panel: tinted when the canvas is
armed, plain when it is not, with a tooltip naming the canvas that would
actually run. That turns the one silent failure mode we have already hit — the
canvas being armed, or not, without it being visible — into something you can
see from the chat.

Notes:

- Click opens the canvas. A long-press or right-click toggling the arm state
  would be genuinely useful, but must be discoverable or it may as well not
  exist.
- Mount it the way `mountLauncher()` mounts the wand entry: SillyTavern builds
  parts of its chrome after extensions load, so a single attempt at startup can
  silently miss.
- Make it optional in settings. Not everyone wants another button there, and
  the send bar is crowded already.

---

## 7. A Git repository for the extension

SillyTavern installs third-party extensions by `git clone` (it uses
`simple-git` server-side, supports installing from a specific branch, and
`auto_update: true` in the manifest makes it `git pull` on startup). So a repo
is the distribution mechanism, not just a backup.

What is needed:

- **Repo name matters**: the clone directory is taken from it, so the extension
  lands in `third-party/<repo-name>/`. Relative imports (`./src/...`) survive
  that fine, but pick the name deliberately — it is what users will see.
- `README.md` with screenshots. The current README is a design document written
  for us; a repo README needs a first paragraph that says what this is to
  somebody who has never heard of it, and a picture of the canvas.
- `LICENSE`.
- `.gitignore` — nothing should be in there today, but keep it honest.
- Version discipline: SillyTavern shows `manifest.version` in its extension
  list, and `auto_update` compares against the repo. Bump it every release.
- Leave `auto_update: false` until this is stable. Silent updates to a thing
  that builds your prompts is not a kindness.
- A `dev` branch, since ST can install from a named branch — that gives you a
  way to try a change without inflicting it on anyone else.

**The trap that will otherwise waste a day:** `manifest.json` currently says
`"js": "index.js"` with no cache-busting query. Browsers cache ES modules
aggressively, so after an update users can keep running the old code and report
that a fix did not work. The previous extension in this folder handled it with
`"js": "index.js?v=30"` and bumped the number every release. Do the same, or
tie the query to `manifest.version` — and remember the `src/*.js` modules are
imported by `index.js`, so they need the same treatment or a hashed filename.

---

## Smaller things worth remembering

- **Connection profiles can exclude the model** (`exclude: ["model"]`). A normal
  SillyTavern send fills it in; a Generate block going through the profile
  directly does not, and the provider answers a bare `Bad Request`. Handled in
  `inspectProfile()` — do not regress it.
- **A profile can name a preset that no longer exists.** SillyTavern silently
  applies no sampler settings at all. We warn; we deliberately do not
  substitute a different preset, because that is the user's configuration to
  fix, not ours to guess at.
- **`reasoning_effort: 'none'` is rejected by Gemini through OpenRouter** with
  an unexplained `Bad Request`, even though it is what SillyTavern sends for its
  own minimum. `'minimal'` is accepted and measurably works: 0 thinking tokens,
  full answer. The fallback that retries without the setting exists for the next
  provider that disagrees.
- **Everything goes through `SillyTavern.getContext()`.** No deep imports into
  ST internals. This is why the extension has survived every change so far, and
  it is worth more than any single feature.
