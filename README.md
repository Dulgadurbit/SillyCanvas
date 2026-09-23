# Prompt Canvas

A node canvas for SillyTavern prompts. Blocks are prompts, wires say how they
combine, and the whole graph compiles into the message array that leaves the
machine — which you can read in full before a single token is spent.

## Milestone 1 — what works now

- **Canvas** with pan, zoom, node drag, wire drawing, right-click menu.
- **Blocks**: Prompt, SillyTavern prompt, Chat history, Injection, Note, Output.
- **Compose wires**: `merge` (stays its own message), `append` and `prepend`
  (folded into the target block's text). Double-click a wire to cycle it.
- **Reading order is vertical.** A block higher on the canvas enters the prompt
  earlier. No exceptions.
- **SillyTavern folder** — your preset's own prompts (Main, Jailbreak, Char
  Description, World Info, Chat History…) appear in the sidebar and drop onto
  the canvas as blocks. Read fresh every time, so switching preset or character
  is reflected immediately. Each can be switched off or overridden *for this
  canvas only* — your preset is never modified.
- **Library** — your own prompts in folders, searchable, drag to canvas.
- **Conditions** per block: always, probability, term search (with regex, scope
  and any/all/none), chat or global variable, or model name.
- **Named canvases**, each exportable and importable as JSON. Pin one to a chat
  (travels in chat metadata), to a character (travels with the card), or set a
  default. Resolution order: chat > character > default.
- **Arm switch.** While it is off SillyTavern behaves exactly as it always has.
  While it is on, the resolved canvas builds the prompt for both chat
  completion and text completion.
- **Preview** — the compiled messages, token count, warnings, and a per-block
  trace saying why each block went in or was skipped.

### Added after the first round of use

- **Create on the canvas.** Double-click empty space and a prompt block appears
  there, focused and ready to type into. It is never saved anywhere until you
  say so.
- **Save by dragging.** Drag a block onto a library folder to file it there.
  The block stays where it was on the canvas: you are filing a copy, not
  moving the block away.
- **Prose history.** A Chat history block can render the conversation as
  continuous paragraphs in one message instead of alternating turns — no
  roles, no speaker labels unless you ask for them, consecutive turns from one
  speaker run together, `*action asterisks*` optionally stripped, and framing
  text above and below. Handed a chat transcript a model reaches for chat-reply
  habits; handed narrative it continues the narrative.
- **The canvas you have open is the canvas that runs.** Picking one from the
  dropdown makes it the active canvas. If a chat or character pin overrides it,
  the status bar says so in amber and offers one click to unpin and run the one
  you are looking at.
- **Library folders stay as you left them**, open or closed, across re-renders.
- **Hideable panes.** Two header buttons put the library and the inspector away
  for more canvas. On a narrow window they start hidden and float over the
  canvas rather than squeezing it.

## The Generate block

A send point. Whatever is wired into its **top** goes to the model; the reply
goes to whatever is wired to its **bottom**.

It has a prompt box of its own, so the question can live in the block rather
than in a separate block wired into it. That text is sent along with whatever
is wired in — after it by default, before it if you prefer.

It is a barrier: the blocks feeding it stay on its side of the wall. Only its
reply travels on. So a thinking pass is history wired into a Generate block
that asks for a plan, and that block wired into Output: the reply gets the
plan, not the material that produced it.

Two Generate blocks is three calls, readable off the picture without tracing a
wire. A Generate whose reply nothing uses is never called. One with nothing
wired in and no text of its own is skipped rather than asked an empty
question. One that is switched off costs nothing.

Each block picks its own connection profile, so a thinking pass can run on a
cheap fast model while the reply runs on your good one. The profile carries its
own API, preset and prompt post-processing, which is what makes the syntax work
per model.

Its reply folds away under the message, under a heading you choose. It is kept
in the message so it survives a reload, and it is never fed back to the model
on a later turn.

**Dry runs never call a model.** SillyTavern fires those to count tokens.
Preview shows placeholders where each reply will land.

## Parallel sends

Generate blocks that do not feed each other go out at the same time. The
compiler groups them into **waves**: everything in a wave is independent, so
the wave goes out at once, and each wave waits for the one before it. Each
Generate block says which wave it is in and who it goes out with, so the
picture tells you what the run will do.

### Tying two blocks together

A **together** tie says "send these two at the same time and wait for both".
Nothing flows along it — it carries no text, takes no part in the prompt, and
only decides *when* the blocks leave.

Every Generate block has a ⚡ dot on **both** side edges. **Drag either dot
onto another Generate block** and the two are tied. The tie draws as a dashed line
side to side rather than top to bottom, because nothing travels along it, and
both blocks then read "wave 1 · at the same time as ...".

Two other ways in, for when your hands are already somewhere else: right-click
a Generate block and pick "Send at the same time as ...", or select an existing
wire between two Generate blocks and press "Send these two together instead",
which drops the text flow and ties them instead.

**A tie outranks the parallel switch.** Tied blocks go out together even when
automatic parallel sending is off, and even past the concurrency limit: you
drew that tie on purpose, and a default should not quietly overrule you. The
switch governs blocks that merely happen to be independent.

The canvas says which of the two you are getting. A Generate block reads
"at the same time as Pacing" when it will go out together, "tied to Pacing"
when a tie is what did it, and "could go out with Pacing — sending one at a
time" when the switch is off. The switch itself sits in the canvas status bar
as **Parallel on / Parallel off**.
A tie is refused between anything but two Generate blocks, and refused when one
already feeds the other — a reply cannot arrive before the request that needs
it.

Two requests go out at once by default otherwise. Raise or lower it in
Extensions settings; some providers and proxies refuse concurrent requests.

Parallel sending is real, not theoretical. Measured through SillyTavern to
OpenRouter: two blocks both started at t=2ms, overlapped for 1.7s, and finished
in 2.06s against 3.78s of request time — so the second call cost 0.3s of wall
clock instead of 1.7s.

**If a block fails in a wave, it is tried again on its own** before being given
up on, which covers a provider that is fine one request at a time and
rate-limits the moment you send two. Transient failures (429, 5xx, timeouts)
are retried once with a short backoff.

Cost is identical either way; only wall-clock changes.

To ask several models the same thing, wire one set of blocks into several
Generate blocks with different profiles, then wire all of their replies into a
final Generate that picks or merges.

## Making a Generate block actually work

A normal SillyTavern send fills in a lot on your behalf. A Generate block goes
out through a connection profile directly, so two gaps show up as a bare
"Bad Request" from the provider. Both are handled:

**Nothing to answer.** A thinking pass is naturally all system messages — a
system prompt block, a system-role history block, the block's own text. The
"merge" post-processing squashes those into one system message with no user
turn, and OpenRouter, Gemini and Claude all reject that. So if nothing in the
list is a user or assistant turn, the last message is sent as the user turn.
The text is untouched; only the label changes.

**No model.** A profile may deliberately not pin a model so it follows the
chat. SillyTavern fills that in for a normal send; nothing fills it in here,
and a chat completion request with no model is rejected. The block now uses the
chat's current model in that case and says so.

**Preview what this sends** shows the exact messages the block would send,
with the connection, model, token limit and thinking setting, and costs
nothing. **Test** runs one real request and shows the reply, what it cost,
how much of that went on thinking, why it stopped, plus anything that had to
be filled in and anything wrong with the profile —
a preset the profile names that SillyTavern cannot find, for instance, which
silently drops every sampler setting. One request, no chat turn spent.

## Choosing a model per block

A Generate block has its own **Model** field under its connection. Leave it
alone and the block follows the connection; set it and this block asks that
model whatever the connection says — a cheap fast model for a thinking pass,
your good one for the reply.

The list comes from whatever SillyTavern already holds for that provider. If
you work through connection profiles you may never have connected through the
main UI, so that list can be empty; **Load model list** asks the provider
directly (the same call SillyTavern's own connection check makes) and keeps the
answer. There is a free-text box too, for a model the list has not caught up
with.

The chosen model shows on the block itself, next to the connection.

## Replies that stop mid-sentence

A reasoning model spends its token budget *thinking* before it writes, and that
thinking comes out of the same allowance as the answer. Measured on Gemini 3.8
Flash through OpenRouter with a 500-token limit: 476 tokens of hidden thinking,
20 left for the reply, `finish_reason: length`, and 79 characters of an answer
that started mid-sentence. Nothing was truncating it — the budget was gone
before the answer began.

So a Generate block has **Let the model think first**, and it is **off** by
default. You are doing the thinking explicitly with the graph; paying the
provider to do it again in secret, out of the same allowance, is not what a
sub-call is for. Same prompt with it off: 0 thinking tokens, 3,059 characters.

Providers disagree about how to ask for this. "none" reads like the obvious
value and is what SillyTavern sends for its own minimum, but Gemini through
OpenRouter rejects it with a bare Bad Request; "minimal" is accepted and
measurably works. If a provider refuses the setting anyway, the block asks
again without it rather than costing you the answer.

When a reply does stop at the limit, the block says which limit and why:
"672 of its 696 reply tokens went to the model's own hidden thinking", or
"ran out of room at its token limit (696 tokens)".

## When a call fails

A failed Generate block contributes **nothing**. It does not paste its own
error message into the prompt you actually send, which is what an earlier
version did — an unreadable "[Generate failed: API request failed]" would end
up in front of the model.

Instead: the block adds nothing, the preview and a toast name the block and the
real reason, and the folded block under the message says it failed and why.
SillyTavern wraps request errors as "API request failed" with the real cause
underneath, so the cause chain is unwrapped before it is shown to you.

## Blocks that do nothing

A block wired to nothing that reaches Output contributes nothing. That is easy
to miss — you wire something up, nothing changes, and there is no error to
read — so those blocks are drawn dashed on the canvas and named in the
preview warnings.

## SillyTavern prompts, in the open

Click a SillyTavern block and you see its actual text, not a character count.
Dynamic ones (World Info, Char Description, Chat History) show what they hold
right now, with a Refresh button to re-read.

Type in that box and it becomes an edit **on this canvas only** — your preset
is untouched, and Revert puts it back. If you decide the edit belongs in
SillyTavern itself, "Write back to preset" does that, and asks first, because
that one affects every chat.

## Milestone 3 — not built yet

- Token budgeting: this version still does not trim history to fit the
  context. It warns you instead.
- Streaming a Generate block's answer as it arrives, rather than waiting.
- Branching: sending different prompts down different paths on a condition.

## Safety

Every interception is wrapped. If compilation fails for any reason the original
SillyTavern prompt is left untouched and the failure is reported in the console
and as a toast. An extension that throws mid-generation is worse than one that
does nothing.

Built entirely against `SillyTavern.getContext()`. No deep imports into ST
internals, so updates that move modules around do not break it.

## Usage

**Adding a block** is a drag: pull one in from the Blocks panel under the
library, or double-click empty canvas for a prompt. Clicking a saved prompt in
the library opens it for editing in place; dragging it puts it on the canvas.

Open it from the wand menu, from Extensions settings, or with `/canvas`.
`/canvas arm` and `/canvas off` toggle it without opening the panel.
