/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime`, and the
 * REAL `llm/stream` waterfall.
 *
 * Nothing about the seam is simulated. The plugin listens on `llm/stream`, and
 * this harness dispatches **that** waterfall — `ctx.waterfall(ctx.llm,
 * 'llm/stream', options, () => source)` — with the registry instance as the
 * listener `this`, exactly as `LlmRuntime.streamWithRegistration` does. So what
 * is under test is Cordis' own dispatch: the same listener list, the same
 * `prepend` placement, the same `next()` composition, the same `global` filter
 * bypass.
 *
 * What is fabricated is the *subject*: the chunk stream a provider would have
 * produced, handed in as the innermost `next`. That is not a simulation of the
 * thing under test either — it is the input to it. The harness piece that *does*
 * the work downstream of the gate is real and shipped: `BlockAssembler` turns
 * whatever the gate emits into the durable blocks **and** decides what the replay
 * envelope is worth, so both halves of the invariant this plugin has to keep are
 * measured with the code the agent loop itself runs:
 *
 * ```js
 * // packages/llm/llm/src/assembler.ts
 * if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
 * ```
 *
 * ## The wire shape
 *
 * The failure a reader cares about is on the wire — the gateway rejects the
 * request — and the mapping that produces it lives in two lines of
 * `packages/llm/llm-deepseek/src/serialize.ts`:
 *
 * ```ts
 * case 'text': return { type: 'text', text: block.text }
 * case 'reasoning': return { type: 'thinking', thinking: block.text, ...signature }
 * ```
 *
 * `@deepseek-ai/dsh-llm-deepseek` publishes `lib/` only — its `./src/*` export map
 * points at a directory the tarball omits — so the two lines cannot be imported
 * from a test here and `wireForm()` below is a **projection** of them rather than
 * the code itself. It is labelled as one wherever it is reported, and no
 * assertion rests on it alone: every claim about removal is also made on the
 * assembled blocks, which *are* produced by shipped code.
 *
 * ## The unrepaired arm
 *
 * `plugin: false` mounts everything else and leaves this plugin out. It is what
 * turns "the block is gone" into "the plugin removed it", and it is also how the
 * suite reproduces the report: without the plugin, the same stream assembles a
 * block whose text is empty, and its wire projection is the body the gateway
 * refuses.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/**
 * A stream of chunks, as the adapter would have yielded them.
 * @param chunks - the chunks, in stream order.
 * @returns an async iterable over them.
 */
export async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * Drain an async iterable into an array.
 * @param iterable - the iterable to drain.
 * @returns every value, in order.
 */
export async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/** A minimal request: the plugin reads only route, session and nothing else. */
export function request(options = {}) {
  return {
    provider: options.provider ?? 'target',
    model: options.model ?? 'model-1',
    messages: options.messages ?? [],
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  }
}

/**
 * Mount a real context with the real LLM registry.
 *
 * `plugin: false` mounts everything else and leaves this plugin out — the control
 * arm. `config` is the plugin's configuration.
 * @param spec - `plugin`, `config`.
 * @returns the context, the captured log, the mount handle, and the dispatch.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 3 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)
  const harness = {
    ctx,
    logged,
    fork: undefined,
    /**
     * Dispatch the real `llm/stream` waterfall and return what the consumer
     * would receive.
     * @param source - the chunk stream standing in for the adapter's output.
     * @param options - the request.
     * @returns the waterfall's return value.
     */
    stream(source, options = {}) {
      return ctx.waterfall(ctx.llm, 'llm/stream', request(options), () => streamOf(source))
    },
    /**
     * Dispatch with a request handed over verbatim — for subjects that must be
     * objects no helper would build, such as one with a hostile accessor.
     * @param source - the chunk stream standing in for the adapter's output.
     * @param options - the request, exactly as given.
     * @returns the waterfall's return value.
     */
    raw(source, options) {
      return ctx.waterfall(ctx.llm, 'llm/stream', options, () => streamOf(source))
    },
    async mount() {
      // `plugin` is this module's namespace; a loader entry mounts its **default**
      // export (`exports.default ?? exports`), and the two differ by the `Config` key.
      // `plugin: 'default'` mounts the object a profile entry actually reaches — see
      // test/mount.spec.mjs for the defect that difference hides.
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      return harness
    },
    async dispose() {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }
  if (spec.plugin !== false) await harness.mount()
  return harness
}

/** The service this plugin provides, or `undefined` when it did not mount it. */
export function service(harness) {
  return harness.ctx.get('emptyBlockGuard')
}

/**
 * Assemble whatever the harness emitted, with the shipped assembler.
 *
 * The assembler is returned rather than just its blocks because it is also the
 * authority on whether the replay envelope survived: `replayState` is `undefined`
 * exactly when the envelope's entry count stopped matching the emitted block
 * count, which is the silent loss this plugin's second half exists to prevent.
 * @param chunks - the emitted chunks.
 * @returns the assembler, already fed, and its blocks.
 */
export function assemble(chunks) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { assembler, blocks: assembler.blocks() }
}

/**
 * The Messages wire form of one assembled block, as `serialize.ts` writes it.
 *
 * **A projection, not the code** — see this module's header. It exists so a
 * failure can be reported in the terms the gateway uses ("this request contained
 * `{"type":"thinking","thinking":""}`"), never so that an assertion can rest on
 * the paraphrase instead of on the assembled blocks.
 * @param block - one assembled content block.
 * @returns the wire block, or `undefined` for a type this projection does not cover.
 */
export function wireForm(block) {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'reasoning') return { type: 'thinking', thinking: block.text }
  return undefined
}

/** Every wire block of an assembled message, in order. */
export function wireBlocks(blocks) {
  return blocks.map(wireForm).filter(block => block !== undefined)
}

/**
 * The blocks an Anthropic-compatible gateway refuses: a text or thinking block
 * whose free-form text field is empty.
 * @param blocks - the assembled blocks.
 * @returns the offending wire blocks, empty when the message is sendable.
 */
export function unrepresentable(blocks) {
  return wireBlocks(blocks).filter(block => (block.type === 'thinking' ? block.thinking : block.text).length === 0)
}

/** The first block of an assembled message with the given type, or a helpful failure. */
export function blockOfType(blocks, type) {
  const block = blocks.find(candidate => candidate.type === type)
  if (block === undefined) throw new Error(`no ${type} block was assembled: ${JSON.stringify(blocks)}`)
  return block
}

/**
 * The durable message the loop would write for one streamed response, with the
 * replay envelope the assembler decided it is worth.
 *
 * This mirrors `packages/core/agent-loop/src/agent.ts`:
 *
 * ```ts
 * const message = createAssistantMessage({
 *   content: live.blocks(),
 *   source: { provider, model, ...live.replayState !== undefined ? { replayState: live.replayState } : {} },
 * })
 * ```
 *
 * `createAssistantMessage` is not exported for a caller that has no session, so
 * the shape is built here — but every value in it comes from the shipped
 * assembler, including the decision that `replayState` is `undefined`.
 * @param assembled - the assembler and its blocks.
 * @param options - route overrides.
 * @returns the message as the session log would carry it.
 */
export function durableMessage(assembled, options = {}) {
  return {
    role: 'assistant',
    content: assembled.blocks,
    source: {
      provider: options.provider ?? 'target',
      model: options.model ?? 'model-1',
      ...assembled.assembler.replayState === undefined
        ? {}
        : { replayState: assembled.assembler.replayState },
    },
  }
}

/**
 * Whether the replay envelope survived assembly, and what it still holds.
 *
 * The contract is stated by `ReplayEnvelope`'s own documentation in
 * `packages/llm/llm/src/types.ts`: *"entries whose length does not match the
 * emitted block count discard the whole envelope"*. A surviving envelope must
 * therefore have one entry per emitted block, in order.
 * @param message - the durable message.
 * @returns `{ survived, entries }`.
 */
export function envelope(message) {
  const replay = message.source.replayState
  return {
    survived: replay !== undefined,
    entries: replay?.blocks,
    aligned: replay === undefined
      ? false
      : Array.isArray(replay.blocks) && replay.blocks.length === message.content.length,
  }
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
