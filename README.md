# @argszero/dsh-empty-block-guard

Fixes a session that is dead from one message index onward, refused before the
model ever starts generating, with

```
invalid Claude request: message[69]: content[0]: thinking type must have non-empty thinking field
HTTP 400 INVALID_REQUEST
```

for a `reasoning` (or `text`) block in the assistant history whose text is empty.

One report, one mechanism, one seam:
[#9239](https://github.com/deepseek-ai/deepseek-harness/discussions/9239) —
*"an empty reasoning block in the history serializes to an empty thinking block,
so an existing session can never be routed to a strict Anthropic Messages gateway
again"*.

## The problem

The block is not the mystery. `llm-deepseek` writes a `reasoning` block to the
Messages wire with no emptiness guard:

```ts
// packages/llm/llm-deepseek/src/serialize.ts
case 'text': return { type: 'text', text: block.text }
case 'reasoning': return {
  type: 'thinking',
  thinking: block.text,
  ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
}
```

An empty `text` therefore becomes `{"type":"thinking","thinking":""}` — a body no
strict Anthropic-compatible gateway accepts, and the reporter measured exactly
which shapes fail and which do not:

| thinking block on the wire | gateway |
|---|---|
| `{"type":"thinking","thinking":""}` (with signature) | refused |
| `{"type":"thinking","thinking":""}` (without) | refused |
| `{"type":"thinking","thinking":null}` | refused |
| non-empty, with signature | accepted |
| non-empty, without signature | accepted |
| no thinking block at all | accepted |

And the block is **durable**. It lives in the session log, not in one request, so
every later turn rebuilds the identical request and is refused at the identical
index:

```
turn N      appendMessage(assistant)  → reasoning block with text:""  LANDED
turn N+1    serialize(log) → {"type":"thinking","thinking":""} → gateway → 400
turn N+2    the same log, the same index, the same 400 — forever
```

The session is not slow and not waiting on a retry budget. It is permanently
unroutable to that gateway, and only a new session escapes.

Two things widen the trap. `llm-pi-ai` builds the same `{ type: 'thinking',
thinking: block.text }` (`packages/llm/llm-pi-ai`), so swapping adapters does not
help. And `readReplay()` returns per-block metadata only when the response model
matches the requested one (`packages/llm/llm-deepseek/src/replay.ts`), so a
cross-model replay sends the block *without* its signature — the same refusal
from a second direction.

## What this plugin does

It removes the block on the **response side of the `llm/stream` waterfall** — the
one seam that reaches both what the loop assembles and what it records.

```ts
// packages/llm/llm/src/index.ts — the waterfall's return value is a value
ctx.on('llm/stream', (options, next) => { … return wrapped }, { global: true, prepend: true })
```

The request side of the same waterfall cannot help, by design: a loop-built
request arrives **deep frozen** ("its content is a pure function of the session
log … so listeners read it, never rewrite it"), and `next()` takes no arguments.
The returned stream is different — it is a value a listener may replace:

```ts
// packages/core/agent-loop/src/agent.ts
for await (const chunk of stream) { … }
```

The loop feeds one `AssistantStreamAttempt` that *both* assembles the durable
`assistant/message` and records the raw chunks for replay, so a block removed
there is removed from the message **and** from the record it will be replayed
from, and the two cannot disagree afterwards. The listener registers with
`prepend: true` because a waterfall's position is part of its meaning: the
removal has to be the last transformation before the consumer.

## Which chunks go, and why it is not just the block

`BlockAssembler.assemble()` returns a closed block **verbatim**, and otherwise
builds one from the text its deltas accumulated. What has to be removed therefore
depends on what was already emitted when the emptiness became known:

| evidence | the assembler would… | what this gate does |
|---|---|---|
| non-empty deltas, or a close with non-empty text | make a representable block | keep, `content-present` |
| start/deltas/close all still buffered, close says empty | write `{"type":"thinking","thinking":""}` | remove the whole block, `empty-close-while-held` |
| the close *is* the only evidence of the block | write the same empty block | remove it, `empty-close-while-held` |
| non-empty deltas already emitted, close says empty | return the empty close verbatim and **discard the text** | drop only the close, `empty-close-after-content` |
| stream ended with the block still open, nothing non-empty streamed | assemble it from the empty deltas | remove the block, `empty-open` |

The fourth row is the one that shows why "drop the block" is not the whole rule: a
close is authoritative, so keeping it would poison the session *and* throw away
text the model did send. Dropping only the close leaves the deltas to assemble,
which is strictly less destructive than either alternative.

## Removing a block is not enough: the replay envelope has to be pruned in step

The terminal chunk may carry a `ReplayEnvelope` whose `blocks` array holds one
adapter-private entry — for `llm-deepseek`, the thinking signature — per emitted
block, in first-seen stream order. The assembler compares that count with the
emitted block count and discards the **whole envelope** when they disagree:

```ts
// packages/llm/llm/src/assembler.ts
if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
```

So dropping a block without dropping its envelope entry trades a loud 400 for the
silent loss of **every** signature in that message, including the ones on the
blocks that were kept — a worse failure, because it is the quiet one. This plugin
removes the entry at the dropped block's own rank, exactly as core's own `kept`
vector does for max-token truncation, so the surviving signatures survive. The
suite measures both halves with the shipped assembler: the block is gone, and
`content.length === replay.blocks.length` still holds, position for position.

## Install

```sh
npm install @argszero/dsh-empty-block-guard@0.1.1
```

Then mount it. The package ships a bundle patch
(`dsh.bundle.patch: ./cordis.patch.yml`), so a deployment that follows the
harness's bundle convention gets it by adding one entry:

```yaml
- insert:
    - id: empty-block-guard
      name: '@argszero/dsh-empty-block-guard'
```

Mounting it directly works the same way and takes the same config:

```ts
import guard from '@argszero/dsh-empty-block-guard'

ctx.plugin(guard, { mode: 'observe' })   // measure before you drop
```

## Measuring before dropping

`mode: 'observe'` runs the same analysis, counts everything it *would* remove,
and emits the stream unchanged. It answers the question the counters otherwise
answer by assumption — *"is this happening in my deployment"* — and it is meant
to be run first.

```ts
const guard = ctx.get('emptyBlockGuard')
guard.snapshot()
```

```jsonc
{
  "mode": "observe",
  "settings": { "mode": "observe", "types": ["text", "reasoning"], "report": true, "historyLimit": 20 },
  "counters": {
    "streams": 41, "errors": 0,
    "verdicts": { "keep": 38, "drop": 3 },
    "reasons": {
      "content-present": 35, "empty-close-while-held": 3,
      "empty-close-after-content": 0, "empty-open": 0
    },
    "envelopes": { "untouched": 38, "pruned": 3, "unaligned": 0 },
    "entriesRemoved": 3
  },
  "recent": [
    {
      "provider": "deepseek-official", "model": "deepseek-chat",
      "sessionId": "…", "index": 0,
      "type": "reasoning", "verdict": "drop", "reason": "empty-close-while-held"
    }
  ],
  "notCovered": [ "…" ]
}
```

`recent` is the whole diagnosis: which route produced the block, which index it
was, and the evidence the decision rested on. `notCovered` is not decoration — a
guard that reports only its decisions leaves an operator unable to tell *"nothing
needed dropping"* from *"the guard never ran"*, and those two look identical in a
log. `guard.reset()` zeroes the counters and drops the retained history.

## Configuration

| option | default | meaning |
|---|---|---|
| `mode` | `'drop'` | `drop` removes the empty block before the consumer sees it; `observe` counts the same decisions and emits the stream unchanged; `off` installs no listener at all |
| `types` | `['text', 'reasoning']` | which of the two text-bearing block types are guarded. Anything unrecognised is dropped from the list rather than widened |
| `report` | `true` | log one line per decision, with the verb the mode earns (`would remove` / `removed`) |
| `historyLimit` | `20` | how many recent decisions `snapshot()` keeps (`0`…`512`); `0` keeps none while still counting |

`drop` is the default because there is no alternative that keeps the block **and**
survives: the only way an empty block becomes representable is to invent text for
it, and a guard that fabricated model output would be a worse failure than the
one it prevents. Removing it is also what the report's own "Expected behavior"
asks for — an empty reasoning block carries no information.

`types` covers **both** text and reasoning, because the wire refuses an empty
member of either and the sibling hole is one serializer line away
(`serialize.ts: case 'text'`). A guard that covered only the reported half would
leave the same session-killing shape behind.

An **unrecognised** `mode` spelling resolves to `observe`, not to `drop`: the
failure mode of a typo has to be the one that changes nothing. `off` still
provides the service, because a mount that answered nothing would be
indistinguishable from a plugin that failed to load.

## Where it attaches

`llm/stream` is a documented waterfall, and a waterfall's *position* is part of
its meaning here. The guard registers with `{ global: true, prepend: true }` —
`prepend` puts it outside every default listener so the removal is the last
transformation the consumer sees, and `global` is because the stream is dispatched
with the registry instance as the listener's `this`, so a mount scoped to a
profile must still cover it.

```
llm/stream waterfall — the return value is the chunk stream
├── empty-block-guard              ← this plugin (prepend): removes the empty block
│   └── (a listener mounted after it with `prepend` sits OUTSIDE it — see below)
├── …other listeners…
└── the adapter's stream

        ↓ the loop consumes exactly this value
agent-loop: AssistantStreamAttempt
   ├── assemble() → the durable assistant/message      ← the block never reaches it
   └── raw chunks → the durable replay record          ← nor this
```

A guarded block is **held** until its emptiness is settled, and everything that
arrives behind it waits in the same buffer, so a held block can never be
overtaken. No chunk is re-ordered and no index is renumbered — `BlockAssembler`
keys blocks by index and records their order at first sight, so the index is part
of the stream's meaning, not a label this plugin may rewrite.

`inject = ['llm']` makes the LLM service a hard requirement: the seam is a chunk
stream, so a composition with no models has nothing for this guard to guard, and
a mount that silently listened to nothing would be indistinguishable from one
that failed to load.

## Honest boundaries

- **It is preventive, not curative.** A session whose log already contains the
  empty block cannot be repaired from here, and this plugin does not pretend
  otherwise. The request side of `llm/stream` arrives deep-frozen, so a poisoned
  history cannot be filtered on its way to the adapter; repairing that needs core
  (a serializer guard, or rejecting the block at the write boundary). If you are
  reading this because a session is already stuck, this package is the fix for
  the *next* attempt, not a rescue for that one.
- **The rule is exactly empty** (`text.length === 0`). A whitespace-only block is
  representable on the wire — it is a non-empty string — so it is left exactly as
  the provider produced it. Narrowing the rule to `trim() === ''` would delete
  content the gateway would have accepted.
- **Only `text` and `reasoning` are judged** — the two the Messages wire spells
  with a free-form text field. Tool-call, image, file and extension blocks are
  passed through untouched, whatever they carry.
- **It covers layers mounted below it.** A listener registered with `prepend`
  *after* this plugin mounts sits outside it and can emit a block this guard never
  saw. In a deployment with several stream rewrites, mount this one last. The
  suite pins both directions.
- **`observe` applies nothing.** It decides, counts and reports exactly as `drop`
  would, so the two runs differ in nothing but the emitted stream.
- **An abandoned stream settles nothing.** If the consumer breaks out of the loop
  — an abort, an interrupt — a block still held is dropped with the stream. That
  is safe because the harness discards the content of an interrupted attempt, and
  a block that is still open at interruption has no text by definition.
- **A drop costs metadata in exactly one case**, and the counters name it: an
  envelope that was never index-aligned with its own stream (`unaligned`) is
  already discarded by the assembler, and this plugin leaves it alone rather than
  fabricating a rewrite.
- **It fails open.** If the gate throws on a stream, everything it had taken is
  released in order and unchanged, the failure is counted under `errors`, and the
  consumer sees the stream it would have seen without the plugin. A guard whose
  bug broke working model calls would be a worse failure than the one it prevents.

## Compatibility

The plugin wraps a documented event's return value and reads one public type
surface, so what it depends on is the shape of `StreamChunk` and the waterfall's
dispatch signature. Peer ranges name the lines that were verified by pinning
every harness package to one line and running the suite against it
(`npm run test:probe-lines`), never inferred:

| peer | range |
|---|---|
| `@deepseek-ai/dsh-llm` | `>=0.1.7-rc.2 <0.2.0 \|\| >=0.2.0-rc.2 <0.2.1` |
| `@deepseek-ai/cordis` | `^4.0.2` |

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines. Each `||` segment's
floor is the build that was actually run, so the range and the probed set are the
same set — a line this plugin has not been run on is a line it does not claim.
The ceiling is the next line rather than the next major, because `StreamChunk` is
a union this gate switches on.

`@deepseek-ai/dsh-llm` is a peer for the type contract, not for a runtime: the
plugin carries `import type { ContentBlockType, ReplayEnvelope, StreamChunk } from
'@deepseek-ai/dsh-llm'`, which TypeScript erases.

**No runtime dependency, at all.** The plugin never imports a harness package for
value — it subscribes to an event the harness dispatches and returns a wrapper
around the stream it was handed. Declaring the runtime as a dependency would be a
dependency the artifact does not have, and in a `profile` deployment a plugin's
own dependency can materialize a second copy of a harness package, which is a
failure this repository has already shipped more than once. The packaging suite
asserts this on the **emitted** JavaScript, not on the sources: `lib/` reaches
nothing but its own modules.

## Tests

```sh
npm test                   # the full suite, against a real cordis context, a real LlmRuntime and the real assembler
npm run test:inject        # mutate the source one rule at a time; every arm must be caught
npm run test:probe-lines   # pin every harness package to one line and re-run the suite
```

The integration suite does not simulate the seam. It builds a real Cordis
context, mounts a real `LlmRuntime`, and dispatches the real `llm/stream`
waterfall with a real `BlockAssembler` reading what the gate emits. The control
arm runs the same chunks with the plugin absent and reproduces the report: the
assembled block is empty, and its wire projection is the body the gateway
refuses. The guarded arm's message is sendable, and the signature of the block
*beside* the removed one is still there — which is the half a naive fix loses.

```
plugin mounted with prepend : the empty block is gone from the message and the record
plugin mounted without it   : the block is there, and its wire form is refused
```

A second pair swaps the mount order to prove the listener position is real
rather than asserted, and a third drives the shipped assembler with an envelope
whose entries no longer match to show what the pairing above is protecting.

## License

MIT
