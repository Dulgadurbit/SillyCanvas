# Silly Canvas

A SillyTavern extension that lets you build your prompt as a graph instead of a list.

Each block is a piece of the prompt: your own text, one of SillyTavern's prompts, the chat history, World Info. Wires connect the blocks, and the canvas turns them into the exact messages that get sent. You can read the whole prompt before anything goes out.

You can also put extra model calls in the middle of the graph. A Generate block can plan the scene, list what each character wants, or clean up a draft, and only its answer goes into the final prompt. A Decider block can send the prompt down different paths depending on what the chat or the text contains.

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
| **Injection** | World Info, Author's Note, summaries and vector memory. |
| **Generate** | Asks a model something before the reply is written. What is wired into it is the question. Its answer goes on to the blocks below it, and its inputs do not. |
| **Decider** | Picks one path. Each key has rules, the first key that matches wins, and a fallback catches the rest. Blocks on paths that were not picked are skipped and cost nothing. |
| **Output** | The final prompt. Everything wired into it is sent. |
| **Note** | For you. Never sent. |

## Wires

Drag from the bottom edge of a block onto another block.

- **merge**: the block above stays its own message.
- **append** and **prepend**: its text is joined onto the end or the start of the block it points at.
- **together** (the lightning dot on a Generate block): sends two Generate blocks at the same time.

Double-click a wire to change its kind.

## Undo

Ctrl+Z undoes the last change to the canvas and Ctrl+Shift+Z (or Ctrl+Y) redoes it. The arrow buttons in the header do the same, and hovering them shows what they will undo.

Each action is one step: adding, deleting, wiring, moving or switching a block. Typing into a block counts as one step per pause, not one per letter. While you are typing in a text box, Ctrl+Z undoes the typing as usual. Undo history lasts until you reload SillyTavern.

## Generate blocks

A Generate block is a model call inside your prompt. Common uses:

- A thinking pass that plans the next scene before the reply is written.
- A pass that pulls out what each character knows or wants.
- A second model that checks or rewrites something.

Each Generate block can use its own connection profile and model. If you leave it on "same as the chat", it uses whatever model the chat is on at that moment. Thinking is off by default, because reasoning models can spend most of the token budget thinking and leave almost nothing for the answer.

While the blocks run, their answers appear at the bottom of the chat, each one labelled with the block that wrote it. When the reply arrives they fold away under it. Open **What it was asked** on any answer to see the exact messages that block was sent.

Generate blocks that don't depend on each other are sent at the same time. If your provider refuses that, Silly Canvas switches to one at a time and tells you.

## Decider blocks

A Decider looks at what is wired into it and picks a path, without calling a model unless you ask it to. Each key gets its own dot on the block, or you can choose where it goes from the **Goes to** list in the inspector.

A key can match on:

- words or phrases that appear, or don't appear
- a number: word count, how often a word appears, message count, a variable, a dice roll
- probability
- time of day and day of the week
- who spoke last
- the character or model name
- a yes or no question put to a model (for example "Does this text read like AI slop?")

Keys are checked from top to bottom, and the first match wins. The AI question is only asked if nothing above it has already matched. Or pick **Weighted random** to choose paths by chance.

## Themes

Click the palette button in the canvas header, or open the Silly Canvas section in the Extensions settings. There are six built-in themes:

- **SillyTavern**: uses your SillyTavern theme for backgrounds and text
- **Dark Night**: near black with bright, clear signals
- **Blue Moon**: deep navy with pale accents
- **Purple Prose**: plum and violet
- **Pink Blink**: a light theme
- **Brown Gown**: warm browns and parchment text

Each colour stands for one thing everywhere it appears. Generate blocks, ties and the answers in the chat always share a colour, for example. Wire kinds also have their own dash patterns, so they can be told apart without colour.

Under **Customise colours** you can change any colour, starting from the theme you picked. The canvas updates as you choose. If two colours are too alike, or text would be hard to read, you get a warning. On a light background, colours are darkened as needed so they stay readable. To share a theme, use **Copy my theme** and send the text. To use someone else's, paste it in and click **Use pasted theme**.

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
