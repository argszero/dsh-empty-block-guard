/**
 * The plugin at the seam: a real `llm/stream` waterfall and the real assembler.
 *
 * Each arm pairs a control with the guarded run, because the claim is not "the
 * stream looks different" but "the message the gateway would have refused is now
 * sendable, and the signatures of the blocks that were *kept* are still there".
 * `plugin: false` is that control: the same chunks, the same dispatch, the same
 * assembler — and the same unrepresentable block, reproduced.
 *
 * @module test/plugin.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assemble, blockOfType, collect, durableMessage, envelope, logText, service, streamOf, unrepresentable, wireBlocks, world,
} from './harness.mjs'

/**
 * The report of #9239, in the shape `llm-deepseek` produces it: a reasoning block
 * that closes with empty text, an ordinary text block beside it, and a replay
 * envelope carrying one entry per block in first-seen order — the signature of
 * the empty thinking block included, because a provider signs what it sent.
 */
const EMPTY_THINKING_HEAD = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'Done.' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
]

/** The terminal chunk for two blocks, the first of them the empty thinking block. */
const EMPTY_THINKING_TAIL = [
  {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: {
      response: { id: 'msg-1' },
      blocks: [{ type: 'reasoning', signature: 'sig-empty' }, { type: 'text' }],
    },
  },
]

const EMPTY_THINKING = [...EMPTY_THINKING_HEAD, ...EMPTY_THINKING_TAIL]

/**
 * The same defect in the middle of a message, where the rank that has to leave
 * the envelope is neither the first entry nor the last — the position a naive
 * "drop the block" fix gets wrong while looking right on a two-block example.
 */
const EMPTY_THINKING_MIDDLE = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Here.' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Here.' } },
  { type: 'block-start', index: 1, blockType: 'reasoning' },
  { type: 'block-end', index: 1, block: { type: 'reasoning', text: '' } },
  { type: 'block-start', index: 2, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 2, text: 'thinking' },
  { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'thinking' } },
  {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: {
      response: { id: 'msg-2' },
      blocks: [{ type: 'text' }, { type: 'reasoning', signature: 'sig-empty' }, { type: 'reasoning', signature: 'sig-kept' }],
    },
  },
]

/** The sibling hole: the same emptiness one serializer line away, on a text block. */
const EMPTY_TEXT = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  { type: 'block-start', index: 1, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 1, text: 'why' },
  { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'why' } },
  {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: { response: { id: 'msg-3' }, blocks: [{ type: 'text' }, { type: 'reasoning', signature: 'sig-why' }] },
  },
]

/** A perfectly ordinary response: nothing to remove, and it must stay that way. */
const ORDINARY = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'checking' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'checking' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'All good.' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'All good.' } },
  {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: { response: { id: 'msg-4' }, blocks: [{ type: 'reasoning', signature: 'sig-a' }, { type: 'text' }] },
  },
]

/** What a run produced: the emitted chunks, the assembled message, its envelope. */
async function run(runWorld, chunks, options = {}) {
  const emitted = await collect(runWorld.stream(chunks, options))
  const assembled = assemble(emitted)
  const message = durableMessage(assembled, options)
  return { emitted, assembled, message, envelope: envelope(message) }
}

describe('the report, reproduced without the plugin', () => {
  it('assembles an empty thinking block whose wire form the gateway refuses', async () => {
    const control = await world({ plugin: false })
    const { assembled, message } = await run(control, EMPTY_THINKING)
    assert.deepEqual(assembled.blocks, [
      { type: 'reasoning', text: '' },
      { type: 'text', text: 'Done.' },
    ])
    // The two lines of `serialize.ts`, projected: this is what the request body
    // would have carried, and what a strict gateway rejects the whole request for.
    assert.deepEqual(unrepresentable(assembled.blocks), [{ type: 'thinking', thinking: '' }])
    // The envelope was intact here — two blocks, two entries — which is exactly
    // why the naive fix has to be careful with it.
    assert.deepEqual(message.source.replayState.blocks, [{ type: 'reasoning', signature: 'sig-empty' }, { type: 'text' }])
    assert.equal(envelope(message).aligned, true)
    await control.dispose()
  })

  it('leaves an ordinary response sendable', async () => {
    const control = await world({ plugin: false })
    const { assembled } = await run(control, ORDINARY)
    assert.deepEqual(unrepresentable(assembled.blocks), [])
    await control.dispose()
  })
})

describe('the plugin at the seam', () => {
  it('makes the reported message sendable and keeps the neighbour signature', async () => {
    const control = await world({ plugin: false })
    const before = await run(control, EMPTY_THINKING)
    const harness = await world()
    const after = await run(harness, EMPTY_THINKING)

    // The defect: present before, gone after.
    assert.deepEqual(unrepresentable(before.assembled.blocks), [{ type: 'thinking', thinking: '' }])
    assert.deepEqual(unrepresentable(after.assembled.blocks), [])
    assert.deepEqual(after.assembled.blocks, [{ type: 'text', text: 'Done.' }])

    // The trap: the envelope survived *and* its entries still line up with the
    // blocks that remain, so the kept block's metadata is not collateral damage.
    assert.equal(after.envelope.survived, true)
    assert.equal(after.envelope.aligned, true)
    assert.deepEqual(after.message.source.replayState.blocks, [{ type: 'text' }])
    assert.deepEqual(after.message.source.replayState.response, { id: 'msg-1' })
    await control.dispose()
    await harness.dispose()
  })

  it('removes the entry at the dropped block rank, not the first or the last', async () => {
    const harness = await world()
    const { assembled, message, envelope: report } = await run(harness, EMPTY_THINKING_MIDDLE)
    assert.deepEqual(assembled.blocks, [
      { type: 'text', text: 'Here.' },
      { type: 'reasoning', text: 'thinking' },
    ])
    assert.equal(report.aligned, true)
    // The middle entry is the one that had to go; the entries around it did not move.
    assert.deepEqual(message.source.replayState.blocks, [{ type: 'text' }, { type: 'reasoning', signature: 'sig-kept' }])
    assert.equal(service(harness).snapshot().counters.entriesRemoved, 1)
    await harness.dispose()
  })

  it('closes the sibling hole on an empty text block', async () => {
    const control = await world({ plugin: false })
    const before = await run(control, EMPTY_TEXT)
    assert.deepEqual(unrepresentable(before.assembled.blocks), [{ type: 'text', text: '' }])
    const harness = await world()
    const after = await run(harness, EMPTY_TEXT)
    assert.deepEqual(unrepresentable(after.assembled.blocks), [])
    assert.deepEqual(after.assembled.blocks, [{ type: 'reasoning', text: 'why' }])
    // The surviving reasoning block is the one whose signature matters, and it is
    // still paired with it.
    assert.deepEqual(after.message.source.replayState.blocks, [{ type: 'reasoning', signature: 'sig-why' }])
    assert.equal(blockOfType(after.assembled.blocks, 'reasoning').text, 'why')
    await control.dispose()
    await harness.dispose()
  })

  it('leaves an ordinary response byte-for-byte as it arrived', async () => {
    const harness = await world()
    const { emitted, assembled, message } = await run(harness, ORDINARY)
    assert.deepEqual(emitted, ORDINARY)
    assert.deepEqual(assembled.blocks, [
      { type: 'reasoning', text: 'checking' },
      { type: 'text', text: 'All good.' },
    ])
    assert.deepEqual(message.source.replayState.blocks, [{ type: 'reasoning', signature: 'sig-a' }, { type: 'text' }])
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.verdicts.keep, 2)
    assert.equal(snapshot.counters.verdicts.drop, 0)
    assert.equal(snapshot.counters.envelopes.untouched, 1)
    assert.deepEqual(snapshot.recent, [])
    await harness.dispose()
  })

  it('records the decision with the route it belonged to', async () => {
    const harness = await world()
    await run(harness, EMPTY_THINKING, { sessionId: 'sess-7' })
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.streams, 1)
    assert.equal(snapshot.counters.errors, 0)
    assert.deepEqual(snapshot.counters.verdicts, { keep: 1, drop: 1 })
    assert.deepEqual(snapshot.counters.reasons, {
      'content-present': 1,
      'empty-close-while-held': 1,
      'empty-close-after-content': 0,
      'empty-open': 0,
    })
    assert.deepEqual(snapshot.counters.envelopes, { untouched: 0, pruned: 1, unaligned: 0 })
    assert.deepEqual(snapshot.recent, [{
      provider: 'target',
      model: 'model-1',
      sessionId: 'sess-7',
      index: 0,
      type: 'reasoning',
      verdict: 'drop',
      reason: 'empty-close-while-held',
    }])
    assert.match(logText(harness.logged), /reasoning block at index 0 closed with empty text; removed the block/)
    await harness.dispose()
  })

  it('names the session in the log line when the request carries one', async () => {
    const harness = await world()
    await collect(harness.stream(EMPTY_TEXT, { sessionId: 'sess-9' }))
    assert.equal(service(harness).snapshot().recent[0].sessionId, 'sess-9')
    assert.match(logText(harness.logged), /text block at index 0 closed with empty text/)
    await harness.dispose()
  })
})

describe('why the removal has to be paired with the envelope', () => {
  it('discards every signature when the block count changes and the entries do not', async () => {
    const control = await world({ plugin: false })
    const emitted = await collect(control.stream(EMPTY_THINKING))
    // The naive guard, reproduced: the empty block's chunks are gone, the
    // terminal chunk is exactly as the provider sent it. The blocks come out
    // right — and the shipped assembler throws the whole envelope away.
    const naive = emitted.filter(chunk => !('index' in chunk) || chunk.index !== 0)
    const assembled = assemble(naive)
    assert.deepEqual(assembled.blocks, [{ type: 'text', text: 'Done.' }])
    assert.equal(assembled.assembler.replayState, undefined)
    const message = durableMessage(assembled)
    assert.equal(envelope(message).survived, false)

    // The same removal through the plugin: the envelope is pruned in step, so the
    // signatures of the blocks that were kept are still there.
    const harness = await world()
    const guarded = await run(harness, EMPTY_THINKING)
    assert.deepEqual(guarded.assembled.blocks, [{ type: 'text', text: 'Done.' }])
    assert.equal(guarded.envelope.survived, true)
    assert.deepEqual(guarded.message.source.replayState.blocks, [{ type: 'text' }])
    await control.dispose()
    await harness.dispose()
  })
})

describe('observe measures without acting', () => {
  it('emits the stream the unguarded control emitted, and counts the same decision', async () => {
    const control = await world({ plugin: false })
    const before = await run(control, EMPTY_THINKING)
    const harness = await world({ config: { mode: 'observe' } })
    const observed = await run(harness, EMPTY_THINKING)
    assert.deepEqual(observed.emitted, before.emitted)
    assert.deepEqual(observed.assembled.blocks, before.assembled.blocks)
    assert.deepEqual(observed.message.source.replayState, before.message.source.replayState)
    assert.deepEqual(unrepresentable(observed.assembled.blocks), [{ type: 'thinking', thinking: '' }])
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'observe')
    assert.deepEqual(snapshot.counters.verdicts, { keep: 1, drop: 1 })
    assert.deepEqual(snapshot.counters.envelopes, { untouched: 1, pruned: 0, unaligned: 0 })
    assert.match(logText(harness.logged), /would remove the block/)
    assert.doesNotMatch(logText(harness.logged), /; removed the block/)
    await control.dispose()
    await harness.dispose()
  })
})

describe('off installs no listener', () => {
  it('emits the unguarded stream and still provides the service', async () => {
    const control = await world({ plugin: false })
    const before = await run(control, EMPTY_THINKING)
    const harness = await world({ config: { mode: 'off' } })
    const emitted = await collect(harness.stream(EMPTY_THINKING))
    assert.deepEqual(emitted, before.emitted)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'off')
    assert.equal(snapshot.counters.streams, 0)
    await control.dispose()
    await harness.dispose()
  })
})

describe('types selects what is guarded', () => {
  it('leaves the text hole open when only reasoning is guarded', async () => {
    const harness = await world({ config: { types: ['reasoning'] } })
    const { assembled } = await run(harness, EMPTY_TEXT)
    assert.deepEqual(assembled.blocks, [{ type: 'text', text: '' }, { type: 'reasoning', text: 'why' }])
    assert.deepEqual(unrepresentable(assembled.blocks), [{ type: 'text', text: '' }])
    await harness.dispose()
  })

  it('guards nothing when the configured types resolve to none', async () => {
    const harness = await world({ config: { types: [] } })
    const { assembled } = await run(harness, EMPTY_THINKING)
    assert.deepEqual(assembled.blocks, [{ type: 'reasoning', text: '' }, { type: 'text', text: 'Done.' }])
    assert.equal(service(harness).snapshot().counters.verdicts.drop, 0)
    await harness.dispose()
  })
})

describe('the listener position', () => {
  /** A block a provider would never emit, used to place a stream in the chain. */
  const INJECTED = [
    { type: 'block-start', index: 9, blockType: 'reasoning' },
    { type: 'block-end', index: 9, block: { type: 'reasoning', text: '' } },
  ]

  it('covers a block emitted by a listener mounted inside it', async () => {
    const harness = await world()
    // Default placement is innermost, so this listener sits *below* the guard and
    // its chunks pass through it — which is what makes the guard's position
    // load-bearing rather than incidental.
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    })
    const blocks = assemble(await collect(harness.stream(ORDINARY))).blocks
    assert.deepEqual(blocks, [
      { type: 'reasoning', text: 'checking' },
      { type: 'text', text: 'All good.' },
    ])
    await harness.dispose()
  })

  it('cannot cover a block emitted by a listener mounted outside it', async () => {
    const harness = await world()
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    }, { prepend: true })
    const blocks = assemble(await collect(harness.stream(ORDINARY))).blocks
    assert.deepEqual(blocks, [
      { type: 'reasoning', text: 'checking' },
      { type: 'text', text: 'All good.' },
      { type: 'reasoning', text: '' },
    ])
    assert.equal(unrepresentable(blocks).length, 1)
    await harness.dispose()
  })

  it('sits outside a listener that was already mounted when it arrived', async () => {
    // `prepend` is the position, and the position is the removal. A deployment
    // that already has its own `llm/stream` listener needs the guard *outside*
    // it: a block that listener contributes after the adapter's stream ends has
    // to be covered too, or the outcome depends on mount order. The guard is
    // mounted last here — the order the README advises, and the one a late
    // addition to an existing composition has.
    const harness = await world({ plugin: false })
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    })
    await harness.mount()
    const blocks = assemble(await collect(harness.stream(ORDINARY))).blocks
    assert.deepEqual(blocks, [
      { type: 'reasoning', text: 'checking' },
      { type: 'text', text: 'All good.' },
    ])
    await harness.dispose()
  })

  it('is reached even when the dispatch filters by context', async () => {
    const harness = await world()
    // Cordis filters listeners by the dispatching service's isolation, and the
    // guard registers as `global` so a scoped mount still covers every call.
    const excluding = { [Symbol.for('cordis.filter')]: () => false }
    const blocks = assemble(await collect(
      harness.ctx.waterfall(
        excluding,
        'llm/stream',
        { provider: 'target', model: 'model-1', messages: [] },
        () => streamOf(EMPTY_THINKING),
      ),
    )).blocks
    assert.deepEqual(blocks, [{ type: 'text', text: 'Done.' }])
    await harness.dispose()
  })
})

describe('fail-open at the plugin', () => {
  it('survives a request whose accessor throws while a decision is being recorded', async () => {
    const harness = await world()
    const hostile = {
      provider: 'target',
      model: 'model-1',
      messages: [],
      get sessionId() { throw new Error('the request accessor threw') },
    }
    const emitted = await collect(harness.raw(EMPTY_THINKING, hostile))
    // Every chunk still reached the consumer, in order: the removal the gate had
    // already applied stands (it was applied before the sink threw), and nothing
    // behind it was lost to the failure.
    assert.deepEqual(emitted.map(chunk => chunk.type), [
      'block-start', 'text-delta', 'block-end', 'finish',
    ])
    assert.deepEqual(assemble(emitted).blocks, [{ type: 'text', text: 'Done.' }])
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.errors, 1)
    assert.match(logText(harness.logged), /stopped guarding one stream after an internal failure/)
    await harness.dispose()
  })
})

describe('the service', () => {
  it('states what it cannot do, and resets', async () => {
    const harness = await world()
    await run(harness, EMPTY_THINKING)
    const before = service(harness).snapshot()
    assert.ok(before.notCovered.length >= 6)
    assert.match(before.notCovered.join('\n'), /Preventive only/)
    service(harness).reset()
    const after = service(harness).snapshot()
    assert.deepEqual(after.counters.verdicts, { keep: 0, drop: 0 })
    assert.deepEqual(after.counters.envelopes, { untouched: 0, pruned: 0, unaligned: 0 })
    assert.equal(after.counters.streams, 0)
    assert.equal(after.counters.entriesRemoved, 0)
    assert.deepEqual(after.recent, [])
    assert.deepEqual(after.notCovered, before.notCovered)
    await harness.dispose()
  })

  it('keeps no history when asked for none, and still counts', async () => {
    const harness = await world({ config: { historyLimit: 0 } })
    await run(harness, EMPTY_THINKING)
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.recent, [])
    assert.equal(snapshot.counters.verdicts.drop, 1)
    await harness.dispose()
  })

  it('keeps only the most recent decisions up to the configured limit', async () => {
    // `0` is the one limit the record() guard already covers; any other bound is
    // the trim's job, and without it the history is a leak in a long session.
    const harness = await world({ config: { historyLimit: 2 } })
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      await collect(harness.stream(EMPTY_TEXT, { sessionId }))
    }
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.recent.map(entry => entry.sessionId), ['sess-2', 'sess-3'])
    // Trimmed, not forgotten: every decision is still counted.
    assert.equal(snapshot.counters.verdicts.drop, 3)
    await harness.dispose()
  })
})

describe('the wire projection itself', () => {
  it('names the shape a strict gateway rejects', () => {
    // A test of the harness's own vocabulary: if this drifts, every failure
    // message about the wire stops describing the wire.
    assert.deepEqual(wireBlocks([{ type: 'reasoning', text: '' }, { type: 'text', text: 'x' }]), [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'x' },
    ])
  })
})
