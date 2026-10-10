/**
 * The one seam that reaches both the message a model's response becomes and the
 * record that response is replayed from — and the one rule that makes using it
 * safe.
 *
 * ## The gap this closes
 *
 * Report #9239: a session wedges permanently because one assistant message in its
 * log contains a `reasoning` block whose text is empty. `llm-deepseek` serializes
 * such a block as `{ type: 'thinking', thinking: '' }`
 * (`packages/llm/llm-deepseek/src/serialize.ts`), a strict Anthropic
 * Messages-compatible gateway rejects the whole request over it, and because the
 * block is durable — it is part of the session log, not of one request — every
 * later turn rebuilds the same request and is refused at the same message index.
 * Only a new session escapes.
 *
 * Nothing on the request side can help: a loop-built request arrives **deep
 * frozen** (`llm/stream`'s own documentation: *"its content is a pure function of
 * the session log … so listeners read it, never rewrite it"*), so a poisoned log
 * cannot be filtered on its way out. What *can* be reached is the **returned**
 * chunk stream of that same waterfall — the value the agent loop iterates
 * (`packages/core/agent-loop/src/agent.ts`: `for await (const chunk of stream)`).
 * The loop feeds one `AssistantStreamAttempt` that both assembles the durable
 * `assistant/message` **and** records the raw chunks for replay, so a block
 * removed there is removed from the message and from the replay record at once.
 *
 * ## Why the removal has to be paired
 *
 * The terminal chunk carries a `ReplayEnvelope` whose `blocks` array holds one
 * adapter-private entry per emitted block, in first-seen stream order — for
 * `llm-deepseek`, the thinking signature. `BlockAssembler` compares that count
 * with the emitted block count and **discards the whole envelope** when they
 * disagree, which would cost every signature in the message, including those of
 * blocks this plugin kept. So dropping a block also drops its envelope entry, at
 * the same rank. Without that the naive fix trades a loud 400 for a silent loss
 * of replay fidelity — a worse failure, because it is the quiet one.
 *
 * ## What it does not claim
 *
 * It is **preventive, not curative**. A session that already has the empty block
 * in its log cannot be repaired from here — the request side is read-only — and
 * this plugin does not pretend otherwise; its own `snapshot()` says so on every
 * read. It also removes the block and nothing else: it never invents text, never
 * renumbers a block, and never touches a block whose type the Messages wire can
 * spell without a free-form text field.
 *
 * @module @argszero/dsh-empty-block-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, GuardMode, Settings } from './config.ts'
import { guardChunks } from './stream.ts'
import type { EnvelopeOutcome, Finding, Policy, Reason, Verdict } from './stream.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'empty-block-guard'

/**
 * The service this plugin is about.
 *
 * It never calls the registry — the seam is a chunk stream — but a composition
 * with no models has nothing for this guard to guard, and a mount that silently
 * listened to nothing would be indistinguishable from one that failed to load.
 */
export const inject = ['llm']

export type { Config, GuardMode, Settings } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { EnvelopeOutcome, EnvelopeReport, Finding, GuardedType, Policy, Reason, Verdict } from './stream.ts'
export { EmptyBlockGate, guardChunks } from './stream.ts'

/** Every verdict a finding can carry. */
export const VERDICTS: readonly Verdict[] = ['keep', 'drop']

/** Every reason a finding can carry, in the order the report lists them. */
export const REASONS: readonly Reason[] = [
  'content-present',
  'empty-close-while-held',
  'empty-close-after-content',
  'empty-open',
]

/** Every outcome a replay envelope can be handled with. */
export const ENVELOPE_OUTCOMES: readonly EnvelopeOutcome[] = ['untouched', 'pruned', 'unaligned']

/** One decision, kept for the bounded history. */
export interface DecisionRecord {
  /** The route the guarded call was bound to. */
  readonly provider: string
  /** The model the guarded call was bound to. */
  readonly model: string
  /** The session the call belonged to, when the call names one. */
  readonly sessionId: string | undefined
  /** The stream index of the block, unchanged. */
  readonly index: number
  /** The block's type. */
  readonly type: 'text' | 'reasoning'
  /** What was decided. */
  readonly verdict: Verdict
  /** The evidence the decision rested on. */
  readonly reason: Reason
}

/** What the guard has seen and done, as a caller reads it back. */
export interface Counters {
  /** Chunk streams guarded. */
  readonly streams: number
  /** Guarded streams that failed inside this plugin and were passed through unchanged. */
  readonly errors: number
  /**
   * Decisions, by verdict: one per guarded block, plus one for a close that was
   * dropped after its block had already streamed text (the one decision that can
   * follow a block's content verdict).
   */
  readonly verdicts: Readonly<Record<Verdict, number>>
  /** Decisions, by the evidence that produced them. */
  readonly reasons: Readonly<Record<Reason, number>>
  /** Terminal replay envelopes, by how they were handled. */
  readonly envelopes: Readonly<Record<EnvelopeOutcome, number>>
  /** Replay entries removed in step with the blocks that were dropped. */
  readonly entriesRemoved: number
}

/** The read-only view `mode: 'observe'` and the tests both use. */
export interface Snapshot {
  readonly mode: GuardMode
  readonly settings: Settings
  readonly counters: Counters
  readonly recent: readonly DecisionRecord[]
  /**
   * What this plugin structurally cannot do, stated on every report.
   *
   * A guard that reports only its decisions leaves an operator unable to tell
   * "nothing needed dropping" from "the guard never ran" — and, worse here,
   * unable to tell a prevented session from one it arrived too late for.
   */
  readonly notCovered: readonly string[]
}

/** The service this plugin provides. */
export interface EmptyBlockGuardService {
  /** Counters, recent decisions and the guard's own declared blind spots. */
  snapshot(): Snapshot
  /** Zero the counters and drop the retained history. */
  reset(): void
}

/** The name under which the service is provided. */
export const SERVICE = 'emptyBlockGuard'

/**
 * The statements the plugin makes about its own blind spots.
 *
 * Each line is a boundary a reader could otherwise mistake for a bug: a log this
 * plugin is too late for, the emptiness rule it does and does not apply, the
 * block types it leaves alone, a listener mounted outside it, the measuring mode,
 * the abandoned stream, and the one case where a drop costs metadata.
 * @returns the lines the report carries.
 */
function blindSpots(): string[] {
  return [
    'Preventive only: a session whose log already contains the empty block cannot be repaired here. The request side of `llm/stream` arrives deep-frozen, so a poisoned history cannot be filtered on its way to the adapter — repairing that needs core.',
    'The rule is exactly empty (`text.length === 0`). A whitespace-only block is representable on the wire — a non-empty string — so it is left exactly as the provider produced it, in both directions. Narrowing to `trim() === \'\'` would delete content the gateway would have accepted.',
    'Only `text` and `reasoning` blocks are judged: they are the two the Messages wire spells with a free-form text field. Tool-call, image, file and extension blocks are passed through untouched, whatever they carry.',
    'Only layers mounted below this plugin are covered: a listener registered with `prepend` after this one runs outside it, so what it sees is not the stream the consumer receives.',
    '`observe` applies nothing. It decides, counts and reports exactly as `drop` would, so the two runs differ in nothing but the emitted stream.',
    'A stream the consumer abandons (an abort, a `break`) settles nothing: a held block is simply not released, and its chunks are dropped with the stream. That is safe because the harness discards the content of an interrupted attempt — and an interrupted attempt is the one place an empty block was about to be written, since a block open at interruption has no text by definition.',
    'Dropping an index also removes its replay entry, so a kept block never loses its signature to a dropped neighbour. The one place a drop costs metadata is an envelope that was not index-aligned with its own stream: it is already discarded by the assembler, and the report counts it under `unaligned` rather than rewriting it.',
  ]
}

/** A fresh, all-zero counter block. */
function zeroCounters(): {
  streams: number
  errors: number
  verdicts: Record<Verdict, number>
  reasons: Record<Reason, number>
  envelopes: Record<EnvelopeOutcome, number>
  entriesRemoved: number
} {
  return {
    streams: 0,
    errors: 0,
    verdicts: Object.fromEntries(VERDICTS.map(verdict => [verdict, 0])) as Record<Verdict, number>,
    reasons: Object.fromEntries(REASONS.map(reason => [reason, 0])) as Record<Reason, number>,
    envelopes: Object.fromEntries(ENVELOPE_OUTCOMES.map(outcome => [outcome, 0])) as Record<EnvelopeOutcome, number>,
    entriesRemoved: 0,
  }
}

/**
 * How a finding reads in one log line.
 *
 * The verb differs per mode on purpose: an operator reading `would drop` knows
 * the deployment is measuring, and one reading `dropped` knows a durable record
 * was changed by this plugin.
 * @param finding - the decision.
 * @param mode - the mode that produced it.
 * @returns the sentence, without the plugin prefix.
 */
function sentence(finding: Finding, mode: GuardMode): string {
  const what = `${finding.type} block at index ${finding.index}`
  switch (finding.reason) {
    case 'content-present':
      return `${what} carried text; left alone`
    case 'empty-close-while-held':
      return mode === 'observe'
        ? `${what} closed with empty text; would remove the block so the request stays sendable`
        : `${what} closed with empty text; removed the block so the request stays sendable`
    case 'empty-close-after-content':
      return mode === 'observe'
        ? `${what} closed with empty text but had already streamed content; would drop the closing block so the assembler keeps that content`
        : `${what} closed with empty text but had already streamed content; dropped the closing block so the assembler keeps that content`
    case 'empty-open':
      return mode === 'observe'
        ? `${what} ended open with nothing streamed; would remove the block so the request stays sendable`
        : `${what} ended open with nothing streamed; removed the block so the request stays sendable`
  }
}

/** How one envelope outcome reads. */
const ENVELOPE_SENTENCE: Readonly<Record<EnvelopeOutcome, string>> = {
  untouched: 'replay envelope passed through untouched (nothing was dropped)',
  pruned: 'replay envelope pruned in step with the dropped blocks; every kept signature survives',
  unaligned: 'replay envelope was not index-aligned with its stream, so it was left alone',
}

/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the mount
 * throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  const counters = zeroCounters()
  const recent: DecisionRecord[] = []

  const record = (entry: DecisionRecord): void => {
    if (settings.historyLimit === 0) return
    recent.push(entry)
    while (recent.length > settings.historyLimit) recent.shift()
  }

  const snapshot = (): Snapshot => ({
    mode: settings.mode,
    settings: { ...settings },
    counters: {
      streams: counters.streams,
      errors: counters.errors,
      verdicts: { ...counters.verdicts },
      reasons: { ...counters.reasons },
      envelopes: { ...counters.envelopes },
      entriesRemoved: counters.entriesRemoved,
    },
    recent: recent.map(entry => ({ ...entry })),
    notCovered: blindSpots(),
  })

  const service: EmptyBlockGuardService = {
    snapshot,
    reset: () => {
      const fresh = zeroCounters()
      counters.streams = fresh.streams
      counters.errors = fresh.errors
      counters.entriesRemoved = fresh.entriesRemoved
      for (const verdict of VERDICTS) counters.verdicts[verdict] = 0
      for (const reason of REASONS) counters.reasons[reason] = 0
      for (const outcome of ENVELOPE_OUTCOMES) counters.envelopes[outcome] = 0
      recent.length = 0
    },
  }

  if (settings.mode === 'off') {
    // The service is still provided. A mount that answered nothing at all would
    // be indistinguishable from a plugin that failed to load.
    ctx.provide(SERVICE, service)
    return
  }

  ctx.on('llm/stream', (options, next) => {
    counters.streams += 1
    const policy: Policy = {
      types: settings.types,
      // `observe` decides exactly as `drop` does and applies nothing, so the two
      // runs are comparable: same findings, same counters, same log, and the
      // emitted stream as the only difference.
      apply: settings.mode === 'drop',
      onFinding: (finding) => {
        counters.verdicts[finding.verdict] += 1
        counters.reasons[finding.reason] += 1
        if (finding.reason === 'content-present') {
          ctx.logger.debug(`empty-block-guard: ${sentence(finding, settings.mode)}`)
          return
        }
        record({
          provider: options.provider,
          model: options.model,
          sessionId: options.sessionId,
          index: finding.index,
          type: finding.type,
          verdict: finding.verdict,
          reason: finding.reason,
        })
        ctx.logger.info(`empty-block-guard: ${sentence(finding, settings.mode)}`)
      },
      onEnvelope: (report) => {
        counters.envelopes[report.outcome] += 1
        counters.entriesRemoved += report.removed
        // Only the two outcomes an operator may have to explain are logged: an
        // ordinary stream with nothing to drop is the common case, and a line per
        // request would be noise.
        if (report.outcome === 'pruned') {
          ctx.logger.debug(
            `empty-block-guard: ${ENVELOPE_SENTENCE[report.outcome]} (removed ${report.removed} of ${report.entries ?? 0})`,
          )
        } else if (report.outcome === 'unaligned') {
          ctx.logger.warn(
            `empty-block-guard: ${ENVELOPE_SENTENCE[report.outcome]} — a dropped block therefore also costs `
            + `the replay metadata of the blocks that were kept (envelope entries: ${report.entries ?? 0}, `
            + `stream blocks: ${report.streamBlocks})`,
          )
        }
      },
      onFailure: (error) => {
        // Fail open, and say so. A guard whose bug breaks working model calls
        // would be a worse failure than the one it prevents, so a failure inside
        // it stops the guard for that stream and never reaches the consumer.
        counters.errors += 1
        if (settings.report) {
          ctx.logger.warn(
            `empty-block-guard: stopped guarding one stream after an internal failure, `
            + `its chunks are passed through unchanged: ${String(error)}`,
          )
        }
      },
    }
    // `prepend` is the position, and the position is the removal: it makes this
    // listener the last transformation the returned stream passes through, so
    // neither the assembler nor the replay record can see the empty block.
    // `global` is because the stream is dispatched with the registry instance as
    // the listener's `this`, and a mount scoped to a profile must still cover it.
    return guardChunks(next(), policy)
  }, { global: true, prepend: true })

  if (settings.report) {
    ctx.logger.info(
      `empty-block-guard: mounted in ${settings.mode} mode on the llm/stream return value, `
      + `guarding ${settings.types.join('+')} (injected: ${inject.join(', ')})`,
    )
  }

  ctx.provide(SERVICE, service)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
