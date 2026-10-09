/**
 * The stream gate: the one place this plugin decides anything.
 *
 * It is deliberately a **pure chunk transformer** — no Cordis, no LLM registry,
 * no I/O. `offer()` takes chunks one at a time, `drain()` returns whatever has
 * become safe to emit, and `finish()` settles a stream that ended with a block
 * still open.
 *
 * ## The block this exists for
 *
 * A `text` or `reasoning` block whose text is empty is not representable on the
 * Anthropic Messages wire: `llm-deepseek` serializes a reasoning block as
 * `{ type: 'thinking', thinking: block.text }` and a text block as
 * `{ type: 'text', text: block.text }`, neither of which an empty string
 * satisfies (`packages/llm/llm-deepseek/src/serialize.ts`). A gateway that
 * validates its input rejects the whole request, so a message containing one such
 * block is unsendable — and because the block is part of the durable session log,
 * every later turn re-sends it and fails at the same place. The session is dead
 * from that message onward.
 *
 * ## The two invariants
 *
 * **What this gate emits is what it was given, in the order it was given**, with
 * the block(s) it decided to drop removed and nothing else touched. Order is why
 * the buffer exists: a guarded block is *held* until its emptiness is settled,
 * and anything arriving behind it waits in the same buffer, so a held block can
 * never be overtaken. No index is renumbered — `BlockAssembler` keys blocks by
 * index and records their order at first sight, so the index is part of the
 * stream's meaning, not a label this gate may rewrite.
 *
 * **A drop is paired with a replay-metadata drop at the same position.** The
 * terminal `finish` chunk may carry a `ReplayEnvelope` whose `blocks` array holds
 * one adapter-private entry — for `llm-deepseek`, the thinking signature — per
 * emitted block, *in first-seen stream order*. `BlockAssembler` discards the
 * **whole envelope** when its entry count no longer matches the emitted block
 * count, which would silently cost every signature in the message, including
 * those of the blocks this gate kept. So a block that is dropped entirely is
 * removed from the envelope at its own rank, and the envelope survives. This is
 * the same rule core applies to its own pruning (`assembler.ts`, the `kept`
 * vector).
 *
 * ## Why some blocks are dropped whole and others only lose their close
 *
 * `BlockAssembler.assemble()` returns a closed block **verbatim**, and otherwise
 * builds one from the text its deltas accumulated. Which chunks have to go
 * therefore depends on what was already emitted when the emptiness was known:
 *
 * - **Nothing was emitted yet** — the block's chunks are still in the buffer, so
 *   the start, the deltas and the close go together. The index then never reaches
 *   the assembler: the block disappears, and the envelope entry at its rank goes
 *   with it.
 * - **Non-empty text was already emitted** — the deltas are past the point where
 *   they can be recalled, so only the closing chunk is dropped and the assembler
 *   falls back to assembling the block from those deltas. This is not a loss: it
 *   is strictly less destructive than either alternative. Had the close been
 *   kept, the block would assemble empty (the close is authoritative) and the
 *   session would be poisoned *and* the text discarded. The shipped adapters
 *   never produce this shape — a translator derives both the deltas and the
 *   closing block from the same accumulated text — so it is evidence about an
 *   adapter, and it is reported as its own reason rather than folded into the
 *   ordinary one.
 *
 * @module @argszero/dsh-empty-block-guard/stream
 */

import type { ContentBlockType, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'

/** The block types this gate can drop: the two the Messages wire spells with a free-form text field. */
export type GuardedType = 'text' | 'reasoning'

/** What the gate decided about one block. */
export type Verdict =
  /** The block's text was non-empty. Nothing was done. */
  | 'keep'
  /** The block was dropped. */
  | 'drop'

/**
 * Why it decided that. Each reason is a distinct shape of evidence, because an
 * operator who can only read "dropped: 3" cannot tell a real prevention from a
 * false positive — nor, here, which of the three shapes of emptiness occurred.
 */
export type Reason =
  /** The block's text was non-empty, so the wire can represent it. */
  | 'content-present'
  /** An index disappeared: nothing of it had been emitted when its close said the text was empty. */
  | 'empty-close-while-held'
  /** Only the close was dropped: the text was empty, but non-empty deltas had already been emitted. */
  | 'empty-close-after-content'
  /** The stream ended with the block open and nothing non-empty ever streamed. */
  | 'empty-open'

/** How the terminal replay envelope was handled on one stream. */
export type EnvelopeOutcome =
  /** Nothing an index disappeared for, so the envelope was passed through untouched. */
  | 'untouched'
  /** Entries were removed at the ranks of the dropped blocks; every kept signature survives. */
  | 'pruned'
  /** Blocks were dropped, but the envelope was not index-aligned with the stream, so it was left alone. */
  | 'unaligned'

/** One decision, as the service and the log report it. */
export interface Finding {
  /** The stream index of the block, unchanged. */
  readonly index: number
  /** The block's type, as the stream declared it. */
  readonly type: GuardedType
  /** What was decided. */
  readonly verdict: Verdict
  /** The evidence the decision rests on. */
  readonly reason: Reason
}

/** What the terminal chunk's replay envelope looked like, for the log and counters. */
export interface EnvelopeReport {
  /** How it was handled. */
  readonly outcome: EnvelopeOutcome
  /** Entries in the envelope when it arrived; `undefined` when the stream carried none. */
  readonly entries: number | undefined
  /** Blocks the stream sighted, which is the count the envelope had to match. */
  readonly streamBlocks: number
  /** Entries removed. */
  readonly removed: number
}

/** What the gate is allowed to do, and where it reports. */
export interface Policy {
  /** The block types to guard. */
  readonly types: readonly GuardedType[]
  /**
   * Whether the decision is applied to the emitted stream.
   *
   * `false` is the measuring posture: every block is judged exactly as it would
   * be, every finding is reported, and the stream is emitted unchanged. The two
   * runs then differ in nothing but the stream, which is what makes a
   * before/after comparison mean something.
   */
  readonly apply: boolean
  /** Called once per guarded block, with the decision. */
  readonly onFinding: (finding: Finding) => void
  /** Called once per guarded stream, for the terminal chunk's replay envelope. */
  readonly onEnvelope?: (report: EnvelopeReport) => void
  /**
   * Called when this gate failed on one stream, once, after which every chunk of
   * that stream is passed through unchanged.
   *
   * The sink itself is the most likely source of such a failure — a logger that
   * throws, an exporter that rejects — so this is reported rather than thrown:
   * a guard whose bug breaks working model calls is a worse failure than the one
   * it prevents.
   */
  readonly onFailure?: (error: unknown) => void
}

/** The index a chunk first sights, for the block order the replay envelope aligns to. */
function firstSight(chunk: StreamChunk): number | undefined {
  switch (chunk.type) {
    case 'block-start':
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
    case 'block-end':
      return chunk.index
    default:
      return undefined
  }
}

/** The guarded type a delta belongs to. */
function deltaType(chunk: StreamChunk): GuardedType | undefined {
  if (chunk.type === 'text-delta') return 'text'
  if (chunk.type === 'reasoning-delta') return 'reasoning'
  return undefined
}

/** The text a closing block carries, when it closes a guarded type at all. */
function closedText(chunk: StreamChunk): { type: GuardedType; text: string } | undefined {
  if (chunk.type !== 'block-end') return undefined
  const block = chunk.block
  return block.type === 'text' || block.type === 'reasoning' ? { type: block.type, text: block.text } : undefined
}

/** One buffered chunk. `held` marks a chunk of a block whose emptiness is not settled. */
interface Slot {
  chunk: StreamChunk | undefined
  held: boolean
}

/** One guarded block the gate is following. */
interface Tracked {
  readonly index: number
  readonly type: GuardedType
  /** The slots this block owns while it is held; empty once settled. */
  slots: Slot[]
  /**
   * `held`: its chunks are in the buffer and nothing of it has been emitted.
   * `released`: non-empty text was emitted, so it is an ordinary block from here.
   * `voided`: every chunk of it was dropped, so its index never reaches the assembler.
   */
  state: 'held' | 'released' | 'voided'
  /** Whether a `block-end` for this block has been decided (later ones are stragglers). */
  closed: boolean
  /** Whether the block's content verdict has been published; it is published once per block. */
  reported: boolean
  /** Whether the close that contradicted that verdict has been published as dropped; at most once. */
  closeReported: boolean
}

/**
 * The gate. One instance per stream; it holds no state across streams.
 *
 * Single-use per stream is a property, not a convention: `finish()` settles every
 * open block, and a second stream fed to the same instance would be judged
 * against the first one's indexes, against a buffer that no longer belongs to it,
 * and against an index order the envelope of neither stream matches.
 */
export class EmptyBlockGate {
  private readonly buffer: Slot[] = []
  private readonly tracked = new Map<number, Tracked>()
  /** Every index the stream first sighted, in that order — the assembler's own block order. */
  private readonly order: number[] = []
  private readonly seen = new Set<number>()
  /** The indexes that were dropped whole, and so must leave the replay envelope too. */
  private readonly vanished = new Set<number>()

  /** @param policy - the configured decision and the finding sink. */
  constructor(private readonly policy: Policy) {}

  /**
   * Take one chunk from the source stream.
   * @param chunk - the next chunk, in stream order.
   */
  offer(chunk: StreamChunk): void {
    if (chunk.type === 'finish') {
      this.settleOpen()
      this.plain(this.withEnvelope(chunk))
      return
    }
    const sighted = firstSight(chunk)
    if (sighted !== undefined) this.sight(sighted)

    switch (chunk.type) {
      case 'block-start': {
        const known = this.tracked.get(chunk.index)
        if (known !== undefined) {
          // The index is already known — from a delta of a delta-only protocol, or
          // from a repeated start the assembler ignores. It must not jump the
          // queue ahead of that block's held chunks.
          if (known.state === 'held' && !known.closed) this.hold(known, chunk)
          else this.plain(chunk)
          return
        }
        if (!this.guards(chunk.blockType)) {
          this.plain(chunk)
          return
        }
        this.hold(this.opened(chunk.index, chunk.blockType), chunk)
        return
      }

      case 'text-delta':
      case 'reasoning-delta': {
        const known = this.tracked.get(chunk.index)
        if (known !== undefined) {
          if (known.closed || known.state !== 'held') {
            this.plain(chunk)
            return
          }
          this.hold(known, chunk)
          if (chunk.text.length > 0) {
            // Non-empty text settles it: the block can be represented. Release
            // here rather than at `block-end` so a long streamed block keeps
            // reaching the consumer as it arrives.
            this.settle(known, 'keep', 'content-present')
          }
          return
        }
        const type = deltaType(chunk)
        if (type === undefined || !this.policy.types.includes(type)) {
          this.plain(chunk)
          return
        }
        // The assembler explicitly tolerates a delta-only protocol, so the first
        // delta may be the first evidence of a block — and a block whose only
        // evidence is an empty delta is exactly one this gate exists for. Holding
        // it costs nothing: an empty delta carries no text to delay.
        const tracked = this.opened(chunk.index, type)
        this.hold(tracked, chunk)
        if (chunk.text.length > 0) this.settle(tracked, 'keep', 'content-present')
        return
      }

      case 'block-end': {
        const closed = closedText(chunk)
        if (closed === undefined || !this.policy.types.includes(closed.type)) {
          // A tool-call (or extension) block, or a type this mount does not
          // guard: not this plugin's subject.
          this.plain(chunk)
          return
        }
        const tracked = this.tracked.get(chunk.index)
        if (tracked === undefined) {
          // No `block-start` and no delta: this closing chunk *is* the block, and
          // the assembler will use it verbatim.
          const fresh = this.opened(chunk.index, closed.type)
          this.hold(fresh, chunk)
          this.close(fresh, closed.text)
          return
        }
        if (tracked.closed) {
          this.plain(chunk)
          return
        }
        if (tracked.state === 'held') {
          this.hold(tracked, chunk)
          this.close(tracked, closed.text)
          return
        }
        // Its deltas already went out, so the close has the last word: a close
        // with empty text would make the assembler return an empty block
        // verbatim, discarding the text with it. Dropping only the close leaves
        // the block to be assembled from the deltas it already streamed.
        tracked.closed = true
        if (closed.text.length > 0) {
          this.plain(chunk)
          this.report(tracked, 'keep', 'content-present')
          return
        }
        if (!this.policy.apply) this.plain(chunk)
        this.reportClose(tracked, 'drop', 'empty-close-after-content')
        return
      }

      default: {
        this.plain(chunk)
        return
      }
    }
  }

  /**
   * Everything that has become safe to emit, in order.
   * @returns the chunks, oldest first; empty while a held block is first in the buffer.
   */
  drain(): StreamChunk[] {
    const out: StreamChunk[] = []
    while (this.buffer.length > 0 && this.buffer[0]?.held !== true) {
      const slot = this.buffer.shift()
      if (slot?.chunk !== undefined) out.push(slot.chunk)
    }
    return out
  }

  /**
   * Settle a stream that ended.
   *
   * A block still open here was never closed, so the assembler will build it from
   * the text its deltas accumulated — the empty string, because a non-empty delta
   * would have released it. It is therefore exactly the block this plugin exists
   * for, and it goes with its index.
   */
  finish(): void {
    this.settleOpen()
  }

  /**
   * Give up deciding on this stream and hand back everything still buffered, in
   * order and exactly once.
   *
   * The failure it exists for happens *after* a chunk was taken — in the
   * decision, in the drain, or in the caller's own finding sink — so the buffered
   * copy is the authoritative one and the chunk that was being offered is
   * released with it rather than emitted separately.
   */
  release(): StreamChunk[] {
    const out: StreamChunk[] = []
    for (const slot of this.buffer) {
      if (slot.chunk !== undefined) out.push(slot.chunk)
    }
    this.buffer.length = 0
    this.tracked.clear()
    return out
  }

  /** Whether this block type is guarded at all. */
  private guards(type: ContentBlockType): type is GuardedType {
    return (type === 'text' || type === 'reasoning') && this.policy.types.includes(type)
  }

  /** Record an index at first sight, which is the position the envelope aligns to. */
  private sight(index: number): void {
    if (this.seen.has(index)) return
    this.seen.add(index)
    this.order.push(index)
  }

  /** Open tracking for a block, held until its emptiness is settled. */
  private opened(index: number, type: GuardedType): Tracked {
    const tracked: Tracked = { index, type, slots: [], state: 'held', closed: false, reported: false, closeReported: false }
    this.tracked.set(index, tracked)
    return tracked
  }

  /** Append a chunk that needs no decision. */
  private plain(chunk: StreamChunk): void {
    this.buffer.push({ chunk, held: false })
  }

  /** Append one of a held block's own chunks. */
  private hold(tracked: Tracked, chunk: StreamChunk): void {
    const slot: Slot = { chunk, held: true }
    this.buffer.push(slot)
    tracked.slots.push(slot)
  }

  /** Decide a block whose stream has closed. */
  private close(tracked: Tracked, text: string): void {
    tracked.closed = true
    if (text.length > 0) this.settle(tracked, 'keep', 'content-present')
    else this.settle(tracked, 'drop', 'empty-close-while-held')
  }

  /** Settle every block still open at the end of the stream. */
  private settleOpen(): void {
    for (const tracked of [...this.tracked.values()]) {
      if (tracked.closed) continue
      tracked.closed = true
      if (tracked.state === 'held') this.settle(tracked, 'drop', 'empty-open')
      else this.report(tracked, 'keep', 'content-present')
    }
  }

  /**
   * Release a block and report what was decided.
   *
   * A drop here removes the whole block: it is only reachable while nothing of
   * the block has been emitted, which is what makes removing its index from the
   * replay envelope correct as well.
   * @param tracked - the block to settle.
   * @param verdict - what is to be done with it.
   * @param reason - the evidence for the decision.
   */
  private settle(tracked: Tracked, verdict: Verdict, reason: Reason): void {
    const dropping = verdict === 'drop' && this.policy.apply
    for (const slot of tracked.slots) {
      slot.held = false
      if (dropping) slot.chunk = undefined
    }
    tracked.slots = []
    if (dropping) {
      tracked.state = 'voided'
      this.vanished.add(tracked.index)
    } else if (tracked.state === 'held') {
      tracked.state = 'released'
    }
    this.report(tracked, verdict, reason)
  }

  /**
   * Publish a block's content verdict.
   *
   * A block reports this exactly once, at the moment its outcome is settled —
   * for a block that streamed content that is its first non-empty delta, and for
   * one that did not it is its close. Without the guard the same block would
   * report twice (once where it was released, once where its close arrived), and
   * the counters would then count chunks rather than blocks.
   */
  private report(tracked: Tracked, verdict: Verdict, reason: Reason): void {
    if (tracked.reported) return
    tracked.reported = true
    this.publish(tracked, verdict, reason)
  }

  /**
   * Publish the one decision that can follow a content verdict: a close that
   * contradicted it was dropped.
   *
   * It has to be published — dropping a close changes a durable record just as
   * removing a block does, and a guard that did it silently would leave an
   * operator unable to explain why the assembled block differs from the close the
   * adapter sent. It is published through its own once-only flag rather than
   * `report()`'s, because this is a second decision about the same block and not
   * a second report of the first one.
   */
  private reportClose(tracked: Tracked, verdict: Verdict, reason: Reason): void {
    if (tracked.closeReported) return
    tracked.closeReported = true
    this.publish(tracked, verdict, reason)
  }

  /** Hand one decision to the sink. */
  private publish(tracked: Tracked, verdict: Verdict, reason: Reason): void {
    this.policy.onFinding({ index: tracked.index, type: tracked.type, verdict, reason })
  }

  /**
   * Remove the dropped indexes from the terminal chunk's replay envelope, at
   * their own ranks.
   *
   * The envelope's entries are one per emitted block **in first-seen stream
   * order**, which is the order this gate recorded. Removing the rank of each
   * vanished index therefore produces exactly the envelope that matches the
   * assembler's surviving block order — and the kept blocks keep their
   * signatures.
   *
   * When the envelope is not index-aligned with this stream to begin with, it is
   * left alone and the outcome is reported as `unaligned`: `BlockAssembler`
   * discards a mismatched envelope on its own, so there is nothing this gate
   * could do for it, and a fabricated rewrite would be worse than the loss it
   * would hide.
   */
  private withEnvelope(chunk: StreamChunk): StreamChunk {
    if (chunk.type !== 'finish') return chunk
    const envelope: ReplayEnvelope | undefined = chunk.replayState
    const entries = Array.isArray(envelope?.blocks) ? envelope.blocks.length : undefined
    const streamBlocks = this.order.length
    const untouched = (): StreamChunk => {
      this.policy.onEnvelope?.({ outcome: 'untouched', entries, streamBlocks, removed: 0 })
      return chunk
    }
    if (this.vanished.size === 0) return untouched()
    // An adapter whose metadata is independent of block structure omits `blocks`
    // entirely — such an envelope "passes through assembly unchanged" — and an
    // adapter that emits none has nothing to lose. Neither is a mismatch, and
    // reporting one as `unaligned` would blame a drop for nothing.
    if (envelope === undefined || envelope.blocks === undefined) return untouched()
    if (entries !== streamBlocks) {
      this.policy.onEnvelope?.({ outcome: 'unaligned', entries, streamBlocks, removed: 0 })
      return chunk
    }
    const ranks = new Set<number>()
    for (const index of this.vanished) {
      const rank = this.order.indexOf(index)
      if (rank >= 0) ranks.add(rank)
    }
    if (ranks.size === 0) return untouched()
    const blocks = envelope.blocks.filter((_, position) => !ranks.has(position))
    this.policy.onEnvelope?.({ outcome: 'pruned', entries, streamBlocks, removed: ranks.size })
    return { ...chunk, replayState: { ...envelope, blocks } }
  }
}

/**
 * Guard one stream: wrap the source so a block the Messages wire cannot represent
 * is removed before the consumer — and the durable record that consumer writes —
 * sees it. Nothing else about the stream changes.
 * @param source - the chunk stream the `llm/stream` waterfall produced.
 * @param policy - the configured decision and the finding sink.
 * @returns the guarded stream. Abandoning the consumer (an abort, a `break`)
 *   settles nothing: a stream that was cut short has no more chunks to emit, and
 *   the harness discards the content of an interrupted attempt that would have
 *   carried these blocks anyway.
 */
export async function* guardChunks(
  source: AsyncIterable<StreamChunk>,
  policy: Policy,
): AsyncIterable<StreamChunk> {
  const gate = new EmptyBlockGate(policy)
  let failed = false
  for await (const chunk of source) {
    if (failed) {
      yield chunk
      continue
    }
    try {
      gate.offer(chunk)
      for (const emitted of gate.drain()) yield emitted
    } catch (error: unknown) {
      failed = true
      policy.onFailure?.(error)
      // Everything the gate had taken, released in order and unchanged. The
      // chunk being offered is in that buffer: the failure it can reach — the
      // decision, the drain, the caller's sink — happens after the chunk was taken.
      for (const emitted of gate.release()) yield emitted
    }
  }
  if (failed) return
  try {
    gate.finish()
    for (const emitted of gate.drain()) yield emitted
  } catch (error: unknown) {
    policy.onFailure?.(error)
    for (const emitted of gate.release()) yield emitted
  }
}
