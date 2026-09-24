# Silly Canvas

A SillyTavern extension that lets you build your prompt as a graph instead of a list.

Each block is a piece of the prompt: your own text, one of SillyTavern's prompts, the chat history, your lorebooks. Wires connect the blocks, and the canvas turns them into the exact messages that get sent. You can read the whole prompt before anything goes out.

You can also put extra model calls in the middle of the graph. A Generate block can plan the scene, list what each character wants, or clean up a draft, and only its answer goes into the final prompt. A Decider block works like a router: it switches blocks on or off depending on what the chat or the text contains, and several paths can fire at once. Each wire can carry exactly the part you want, such as the last user message or only the text inside a tag.

When the canvas is switched off, SillyTavern builds the prompt exactly as it normally does.

## Install

1. In SillyTavern, open **Extensions** and click **Install extension**.
2. Paste `https://github.com/Dulgadurbit/SillyCanvas` and install.
3. Reload SillyTavern.

Open the canvas with the button next to Send, from the wand menu, or by typing `/canvas`.

Silly Canvas works with Chat Completion APIs (OpenAI, OpenRouter, Claude, Gemini and others). Text Completion is wired up but has had very little testing.

## Getting started

1. Open the canvas and click the wand button (**Seed from SillyTavern's current prompt order**). This copies your current prompt order onto the canvas, so you start from what you already send.
2. Click **Preview prompt** to see the messages the canvas would send.
3. Switch the canvas on with the **Arm** switch in the canvas header, or right-click the canvas button next to Send.
4. Send a message as usual.

Blocks are read from top to bottom. If you want something earlier in the prompt, move its block higher.

## Blocks

| Block | What it does |
|---|---|
| **Prompt** | Your own text, with a role (system, user or assistant). SillyTavern macros like `{{char}}` and `{{user}}` work. |
| **SillyTavern** | One of your preset's prompts, read live from the preset. You can change it for one canvas without touching the preset. |
| **History** | The chat, as separate turns or as one block of prose. You can limit it to the last few messages. |
| **Injection** | World Info, Author's Note, summaries and vector memory, as SillyTavern prepared them. |
| **Lorebook** | Entries from your lorebooks, chosen by this block: as SillyTavern would, by keys in the text wired in, every entry, or only the ones you pick. See below. |
| **Generate** | Asks a model something before the reply is written. What is wired into it is the question. Its answer goes on to the blocks below it, and its inputs do not. |
| **Decider** | A router. Each output has its own rules; every output that matches fires (or only the first, or the AI picks, or by chance). Blocks on paths that were not taken are skipped and cost nothing. |
| **Output** | The final prompt. Everything wired into it is sent. |
| **Note** | For you. Never sent. |

## Wires

Drag from the bottom edge of a block onto another block.

- **merge**: the block above stays its own message.
- **append** and **prepend**: its text is joined onto the end or the start of the block it points at.
- **together** (the lightning dot on a Generate block): sends two Generate blocks at the same time.

Double-click a wire to change its kind.

Each wire also has a **mode**, set in the inspector or from the wire's right-click menu:

- **Send** (solid, the default): the text travels along the wire.
- **Activate** (dotted): nothing travels. A block with Activate wires only runs when at least one of them fires, and then uses its own content. From a Decider output, the wire fires when that output is chosen; from any other block, when that block is on. A Generate block that is not switched on is never called.
- **Forward result** (dash-dot, from a Decider or a Lorebook block): sends the result as text: a Decider's chosen outputs or the words that matched, or the names of the lorebook entries that fired. Put `{{result}}` in the target block's text to place it; otherwise it is joined like any wired text.

## Send what? (wire filters)

Click a wire to choose exactly what travels along it. The same block can feed different places different pieces: the whole story to the final prompt, and only the last reply to a Decider.

- **Messages:** all, the last N or the first N; from anyone, only the user or only the character; only certain message numbers (`23, 25, 30-35`, the # numbers SillyTavern shows); leave out the newest N.
- **Text:** keep the whole text or the first/last paragraphs, keep only what is inside a tag (`plan` keeps `<plan>…</plan>`), remove thinking.
- **Arrives as:** separate messages, or one piece of text, optionally with the speaker's name in front of each part.

The wire's label shows the filter (`last 5 · user`), and **Show what it carries now** previews the result for the open chat, with a token count.

## Lorebook blocks

A **Lorebook** block reads your lorebooks (World Info) directly, so the canvas decides which entries are sent and where they go.

- **Which lorebooks:** the chat's, the character's (including its extra lorebooks), the persona's and the global ones, each switched on or off, plus any others you add by name.
- **Which entries:**
  - **As SillyTavern would.** On a send this is exactly what SillyTavern activated; the preview estimates it.
  - **Entries whose keys appear in** the text wired into the block, or in the last N chat messages. Wire a Generate block that plans the scene into it, and the lore for whatever the plan mentions comes along. The wired text stops at the block and is not sent on.
  - **Every entry**, **only constant entries**, or **only the entries you tick**.
- **Filters:** title contains, group, entry position, only Memory Books memories (optionally skipping scenes still in the recent chat), and whether switched-off entries count.
- **How much:** at most N entries and/or a token budget, ordered by the entries' own order, most recently mentioned, or alphabetically.
- **How it is sent:** one message or one per entry, with or without titles, a role, and text before and after.
- **Keep these lorebooks out of World Info**, so the same lore is not sent twice when World Info is also on the canvas.
- **Which entries fire now?** previews the entries and the key that triggered each.

Keys are matched the way SillyTavern matches them (regex keys, whole words, case, secondary keys), without its extras such as sticky, cooldown, groups' scoring or vectors. Those only apply in "As SillyTavern would" on a real send.

To route on which lore fired, wire the Lorebook block into a Decider and set the wire to **Forward result**: it carries the entry names (`Dragon, Magic`), which the Decider's word rules can check.

## Working on the canvas

- **Duplicate** a block with Ctrl+D, its right-click menu, or the inspector. Ctrl+Shift+D also copies the wires coming into it.
- **Hover or select** a block to light up everything that feeds it. Blocks that only switch it on get a dashed outline.
- Each block shows roughly how many tokens it adds, from the last preview.

## Undo

Ctrl+Z undoes the last change to the canvas and Ctrl+Shift+Z (or Ctrl+Y) redoes it. The arrow buttons in the header do the same, and hovering them shows what they will undo.

Each action is one step: adding, deleting, wiring, moving or switching a block. Typing into a block counts as one step per pause, not one per letter. While you are typing in a text box, Ctrl+Z undoes the typing as usual. Undo history lasts until you reload SillyTavern.

## Generate blocks

A Generate block is a model call inside your prompt. Common uses:

- A thinking pass that plans the next scene before the reply is written.
- A pass that pulls out what each character knows or wants.
- A second model that checks or rewrites something.

The **Instruction** box is for a short ask like "List three beats for the next scene". It is sent after the blocks wired in, so it is the last thing the model reads. Leave it empty and the lowest block wired in becomes the instruction instead. The block itself shows which it is.

Each Generate block can use its own connection profile and model. If you leave it on "same as the chat", it uses whatever model the chat is on at that moment. Thinking is off by default, because reasoning models can spend most of the token budget thinking and leave almost nothing for the answer.

While the blocks run, their answers appear at the bottom of the chat, each one labelled with the block that wrote it. When the reply arrives they fold away under it. Open **What it was asked** on any answer to see the exact messages that block was sent.

Generate blocks that don't depend on each other are sent at the same time. If your provider refuses that, Silly Canvas switches to one at a time and tells you.

## Loops

Some jobs work better in several goes, like cleaning AI phrasing out of a draft. There are two ways to repeat work.

**Passes**, on a single Generate block. Set **Passes** to 3 and the block runs up to three times, each pass working on its own last answer. It stops early when a pass changes nothing, so you only pay for the passes that did something.

**Loop wires**, for a whole section. Drag a wire from a Generate block, or from a Decider key, back up to a block above it. Everything between the two ends runs again, and the result is handed back to the top as "your previous attempt". Each loop has a limit, shown on the wire, that you can change by clicking it.

- A loop from a **Generate block** runs until the limit, or until the result stops changing, and then carries on down the canvas.
- A loop from a **Decider key** runs each time that key is chosen. Once the limit is reached, the key is taken off the Decider's list, so it has to choose something else. For example: draft, check for "Elara", and if found go back and redraft, at most three times.

Only Generate blocks and Decider keys can loop, because only they can end a loop. The canvas and the preview show a loop's first run; the loops themselves happen when you send.

## Decider blocks

A Decider looks at what is wired into it and decides which blocks run, like a router. Click the **?** on the block for a short guide with two examples.

A new Decider starts empty and does nothing until you choose **how it routes**:

- **Every output that matches**: every output whose rules hold fires. If a text mentions both red and blue, both the Red and Blue outputs fire.
- **Only the first match**: outputs are checked top to bottom, and the first that holds fires. Old canvases work this way.
- **Let the AI sort**: describe each output in plain words, and one small model call picks the ones that apply (one, or several).
- **Random (weighted)**: a pick by chance.

**Otherwise** fires when nothing else does. It can be left unwired.

**Inputs.** Wire as many blocks into its top as you like. Each rule reads all of them together, or one on its own.

**Outputs.** Each output has its own dot on the block, or you choose where it goes from the **Goes to** list in the inspector. An output's rules can match on:

- words or phrases that appear, or don't appear
- a number: word count, how often a word appears, message count, a variable, a dice roll
- probability
- time of day and day of the week
- who spoke last
- the character or model name
- a yes or no question put to a model (for example "Does this text read like AI slop?")

Several rules on one output can be joined with AND or OR, and any rule can be flipped with **NOT**. An AI question is only asked when nothing before it has already settled things.

**Test it.** The test box at the bottom of the inspector takes some sample text and shows which outputs would fire, and why. Nothing is sent.

Combine it with the wire modes: an **Activate** wire from an output switches a block on, and a **Forward result** wire sends the decision (`Red, Blue`, or the words that matched) into `{{result}}`.

## Themes

Click the palette button in the canvas header, or open the Silly Canvas section in the Extensions settings. Each built-in theme has its own look, not just its own colours:

| Theme | Look |
|---|---|
| **SillyTavern** | Follows your SillyTavern theme for backgrounds, text and font |
| **Midnight** | Clean modern dark, rounded, deep shadows, dot grid |
| **Blueprint** | Blue drafting paper: grid lines, sharp outlines, typewriter labels, right-angled wires |
| **Parchment** | A light storybook page: cream paper, book serif, ink-brown lines, coloured headers |
| **Neon** | Black and violet, glowing wires and edges, bold lines, soft round shapes |
| **Terminal** | Green phosphor on black: monospace, square boxes, scanlines, right-angled wires |
| **Petal** | Light and rosy: round shapes, a friendly font, coloured headers |

Under **Change the look** you can mix your own: shape (sharp, rounded, soft), font, canvas background (dots, grid lines, paper, scanlines, plain), curved or right-angled wires, line weight, block headers coloured by type, and depth (flat, shadows or glow). Every theme except SillyTavern also restyles SillyTavern's own buttons and fields inside the canvas, so light themes read properly.

Each colour stands for one thing everywhere it appears. Generate blocks, ties and the answers in the chat always share a colour, for example. Wire kinds also have their own dash patterns, so they can be told apart without colour.

Under **Customise colours** you can change any colour, starting from the theme you picked. The canvas updates as you choose. If two colours are too alike, or text would be hard to read, you get a warning. On a light background, colours are darkened as needed so they stay readable. To share a theme (colours and look), use **Copy my theme** and send the text. To use someone else's, paste it in and click **Use pasted theme**.

## Canvases

You can keep several canvases and choose which one runs:

- **Pin to this chat**: this chat always uses it.
- **Pin to character**: saved in the character card, so it goes with the card when you export it.
- **Make default**: used everywhere else.

A chat pin beats a character pin, and a character pin beats the default. Hover the button next to Send to see which canvas will run. Canvases can be exported and imported as JSON.

## The library

Save prompts to the library to reuse them across canvases. Drag a block onto the library panel to save it, or drag a saved prompt onto the canvas to use it.

## Checking what was sent

- **Preview prompt**: what would be sent right now, with a token count and a line for every block saying why it was included or skipped.
- **What was actually sent**: the last real send.
- **Test** (on a Generate block): sends that block on its own and shows the reply, the token use and why it stopped.

## Development

There is no build step. Edit the files and reload SillyTavern with Ctrl+Shift+R.

Tests run with Node. The ones that use a fake page need jsdom (`npm install jsdom`):

```
node tests/decider.test.mjs
```

To release a new version, run `node tools/bump-version.mjs 0.7.0`. It updates the manifest and the `?v=` on every import, so browsers load the new code instead of a cached copy.

## License

MIT. See [LICENSE](LICENSE).
