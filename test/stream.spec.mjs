/**
 * The gate as a unit: no Cordis, no registry, no session — just chunks in and
 * chunks out, and the decisions it reached on the way.
 *
 * The integration spec covers the seam; this one covers the shapes that never
 * reach it. Every case that matters here is one the shipped adapters do not
 * produce (a delta-only protocol, a close that contradicts its own deltas, a
 * straggler after a settled block) — the gate is judged on them because a
 * misbehaving adapter is exactly the thing a guard has to survive, and because
 * the alternative is finding out in production.
 *
 * @module test/stream.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EmptyBlockGate, guardChunks } from '../lib/stream.js'

/** Drain an async iterable. */
async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/** Turn an array into the async iterable the gate is handed. */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/** A terminal chunk carrying one envelope entry per named block. */
function finishWith(blocks, reason = { kind: 'stop' }) {
  return {
    type: 'finish',
    reason,
    ...blocks === undefined ? {} : { replayState: { response: { id: 'msg' }, blocks } },
  }
}

/**
 * Run the gate over a chunk list.
 * @param chunks - the source chunks.
 * @param options - `types` and `apply` for the policy.
 * @returns the emitted chunks, the findings, and the envelope report.
 */
async function run(chunks, options = {}) {
  const findings = []
  const envelopes = []
  const emitted = await collect(guardChunks(streamOf(chunks), {
    types: options.types ?? ['text', 'reasoning'],
    apply: options.apply ?? true,
    onFinding: (finding) => {
      findings.push(finding)
      options.onFinding?.(finding)
    },
    onEnvelope: report => envelopes.push(report),
    ...options.onFailure === undefined ? {} : { onFailure: options.onFailure },
  }))
  return { emitted, findings, envelopes }
}

/** A stream of one reasoning block, closed with the given text. */
function reasoning(text, index = 0) {
  return [
    { type: 'block-start', index, blockType: 'reasoning' },
    ...text.length === 0 ? [] : [{ type: 'reasoning-delta', index, text }],
    { type: 'block-end', index, block: { type: 'reasoning', text } },
  ]
}

describe('the gate passes an ordinary stream through unchanged', () => {
  it('emits every chunk in order, with equal values', async () => {
    const chunks = [
      ...reasoning('checking', 0),
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'All good.' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'All good.' } },
      finishWith([{ type: 'reasoning', signature: 'sig-a' }, { type: 'text' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings, [
      { index: 0, type: 'reasoning', verdict: 'keep', reason: 'content-present' },
      { index: 1, type: 'text', verdict: 'keep', reason: 'content-present' },
    ])
    assert.deepEqual(envelopes, [{ outcome: 'untouched', entries: 2, streamBlocks: 2, removed: 0 }])
  })

  it('leaves a chunk type it does not know alone', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      finishWith([{ type: 'tool-call' }]),
    ]
    const { emitted, findings } = await run(chunks)
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings, [])
  })

  it('keeps a whitespace-only block — the rule is exactly empty', async () => {
    const chunks = [...reasoning('   '), finishWith([{ type: 'reasoning', signature: 'sig' }])]
    const { emitted, findings } = await run(chunks)
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings, [{ index: 0, type: 'reasoning', verdict: 'keep', reason: 'content-present' }])
  })
})

describe('an empty block goes, and takes its envelope entry with it', () => {
  it('removes a closed empty reasoning block at index 0', async () => {
    const chunks = [
      ...reasoning('', 0),
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'reasoning', signature: 'sig-empty' }, { type: 'text' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, [
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'text' }]),
    ])
    assert.deepEqual(findings, [
      { index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-close-while-held' },
      { index: 1, type: 'text', verdict: 'keep', reason: 'content-present' },
    ])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 2, streamBlocks: 2, removed: 1 }])
  })

  it('removes the entry at the rank of a middle block, not the first or the last', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Here.' } },
      ...reasoning('', 1),
      { type: 'block-start', index: 2, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 2, text: 'why' },
      { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'why' } },
      finishWith([
        { type: 'text' },
        { type: 'reasoning', signature: 'sig-empty' },
        { type: 'reasoning', signature: 'sig-kept' },
      ]),
    ]
    const { emitted, envelopes } = await run(chunks)
    const finish = emitted.at(-1)
    assert.deepEqual(finish.replayState.blocks, [{ type: 'text' }, { type: 'reasoning', signature: 'sig-kept' }])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 3, streamBlocks: 3, removed: 1 }])
  })

  it('removes the entry at the block rank, which is not its index when indexes skip', async () => {
    // The envelope carries one entry per *seen* block in first-seen order — not
    // one per index value. A stream whose indexes skip (an adapter numbering its
    // blocks by something other than 0..n) is where rank and index come apart,
    // and the entry that has to go is the one at the rank. This is the case a
    // `envelope.blocks.filter((_, position) => position !== index)` would get
    // wrong while looking right on every contiguous example.
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Here.' } },
      { type: 'block-start', index: 4, blockType: 'reasoning' },
      { type: 'block-end', index: 4, block: { type: 'reasoning', text: '' } },
      finishWith([{ type: 'text' }, { type: 'reasoning', signature: 'sig-empty' }]),
    ]
    const { emitted, envelopes } = await run(chunks)
    assert.deepEqual(emitted.at(-1).replayState.blocks, [{ type: 'text' }])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 2, streamBlocks: 2, removed: 1 }])
  })

  it('removes two entries when two blocks go', async () => {
    const chunks = [
      ...reasoning('', 0),
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Here.' } },
      ...reasoning('', 2),
      finishWith([{ type: 'reasoning' }, { type: 'text' }, { type: 'reasoning' }]),
    ]
    const { emitted, envelopes } = await run(chunks)
    assert.deepEqual(emitted.at(-1).replayState.blocks, [{ type: 'text' }])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 3, streamBlocks: 3, removed: 2 }])
  })

  it('removes a block the stream ended with still open', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'reasoning' }, { type: 'text' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted.at(-1).replayState.blocks, [{ type: 'text' }])
    // A finding is published the moment its decision settles, and index 0 is not
    // settled until the stream ends — so the block that *closed* reports first,
    // even though it is the later one. What must never happen is a missed or a
    // duplicated decision; the publication order is the stream's own.
    assert.deepEqual(findings, [
      { index: 1, type: 'text', verdict: 'keep', reason: 'content-present' },
      { index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-open' },
    ])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 2, streamBlocks: 2, removed: 1 }])
  })

  it('settles a source that ends without a terminal chunk', async () => {
    // A truncated source yields no `finish`, so the end of the source is the
    // only evidence the stream is over — and a block left open there assembles
    // from an empty delta list. Nothing of it is emitted: it was held, and it is
    // dropped.
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '' },
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, [])
    assert.deepEqual(findings, [{ index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-open' }])
    assert.deepEqual(envelopes, [])
  })

  it('drops the close of a block whose deltas already streamed text', async () => {
    // A close that contradicts its own deltas. The close is authoritative for the
    // assembler, so keeping it would assemble an empty block *and* discard the
    // text; dropping only the close keeps the text and the index, and therefore
    // the envelope entry.
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'streamed' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
      finishWith([{ type: 'reasoning', signature: 'sig-0' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'streamed' },
      finishWith([{ type: 'reasoning', signature: 'sig-0' }]),
    ])
    assert.deepEqual(findings, [
      { index: 0, type: 'reasoning', verdict: 'keep', reason: 'content-present' },
      { index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-close-after-content' },
    ])
    // Nothing left the block order, so nothing left the envelope.
    assert.deepEqual(envelopes, [{ outcome: 'untouched', entries: 1, streamBlocks: 1, removed: 0 }])
  })

  it('does not let an empty delta settle a block that already started', async () => {
    // The shipped adapters omit a delta whose text is empty, so this is a shape
    // only a misbehaving adapter produces — and it is exactly the shape that
    // would settle a block as content before its emptiness is known.
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '' },
      finishWith([{ type: 'reasoning' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, [finishWith([])])
    assert.deepEqual(findings, [{ index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-open' }])
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 1, streamBlocks: 1, removed: 1 }])
  })

  it('handles a delta-only protocol, empty and not', async () => {
    const empty = await run([
      { type: 'reasoning-delta', index: 0, text: '' },
      finishWith([{ type: 'reasoning' }]),
    ])
    // The block's only evidence was an empty delta, so its index never reaches the
    // assembler and its envelope entry leaves with it. The emptied envelope is
    // *aligned* — zero entries for zero emitted blocks — which is why removing the
    // entry is the whole repair and leaving it would cost the message its replay.
    assert.deepEqual(empty.emitted, [finishWith([])])
    assert.deepEqual(empty.findings, [{ index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-open' }])

    const filled = await run([
      { type: 'reasoning-delta', index: 0, text: 'x' },
      { type: 'text-delta', index: 1, text: 'y' },
      finishWith([{ type: 'reasoning' }, { type: 'text' }]),
    ])
    assert.equal(filled.emitted.length, 3)
    assert.equal(filled.findings.filter(finding => finding.verdict === 'drop').length, 0)
  })

  it('lets the closing chunk be the only evidence of a block', async () => {
    const chunks = [
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'reasoning' }, { type: 'text' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks)
    assert.deepEqual(emitted, [
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'text' }]),
    ])
    assert.deepEqual(findings[0], { index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-close-while-held' })
    assert.deepEqual(envelopes, [{ outcome: 'pruned', entries: 2, streamBlocks: 2, removed: 1 }])
  })

  it('passes a straggler after a settled block without deciding twice', async () => {
    const chunks = [
      ...reasoning('', 0),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
      finishWith(undefined),
    ]
    const { emitted, findings } = await run(chunks)
    assert.deepEqual(emitted, [{ type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } }, finishWith(undefined)])
    assert.equal(findings.length, 1)
  })
})

describe('the envelope is only rewritten when it can be', () => {
  it('leaves an envelope that never matched its stream alone, and says so', async () => {
    const chunks = [
      ...reasoning('', 0),
      finishWith([{ type: 'reasoning' }, { type: 'text' }]),
    ]
    const { emitted, envelopes } = await run(chunks)
    assert.deepEqual(emitted.at(-1).replayState.blocks, [{ type: 'reasoning' }, { type: 'text' }])
    assert.deepEqual(envelopes, [{ outcome: 'unaligned', entries: 2, streamBlocks: 1, removed: 0 }])
  })

  it('treats a stream with no envelope at all as nothing to do', async () => {
    const chunks = [...reasoning('', 0), finishWith(undefined)]
    const { emitted, envelopes } = await run(chunks)
    assert.equal(emitted.length, 1)
    assert.deepEqual(envelopes, [{ outcome: 'untouched', entries: undefined, streamBlocks: 1, removed: 0 }])
  })

  it('treats an envelope without per-block entries as nothing to do', async () => {
    const chunks = [
      ...reasoning('', 0),
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'msg' } } },
    ]
    const { envelopes } = await run(chunks)
    assert.deepEqual(envelopes, [{ outcome: 'untouched', entries: undefined, streamBlocks: 1, removed: 0 }])
  })
})

describe('the measuring posture', () => {
  it('reports the same decision and emits the stream unchanged', async () => {
    const chunks = [
      ...reasoning('', 0),
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
      finishWith([{ type: 'reasoning', signature: 'sig-empty' }, { type: 'text' }]),
    ]
    const { emitted, findings, envelopes } = await run(chunks, { apply: false })
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings, [
      { index: 0, type: 'reasoning', verdict: 'drop', reason: 'empty-close-while-held' },
      { index: 1, type: 'text', verdict: 'keep', reason: 'content-present' },
    ])
    assert.deepEqual(envelopes, [{ outcome: 'untouched', entries: 2, streamBlocks: 2, removed: 0 }])
  })
})

describe('the gate survives its own failures', () => {
  it('releases everything it took, in order and exactly once', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'text-delta', index: 1, text: 'x' },
      finishWith(undefined),
    ]
    const failures = []
    const { emitted, findings } = await run(chunks, {
      onFailure: error => failures.push(error),
      onFinding: () => { throw new Error('the sink threw') },
    })
    // A sink that throws on a decision stops the gate: the failure is reported
    // once, every chunk it had buffered still arrives — once, in order — and the
    // rest of the stream is passed through untouched.
    assert.deepEqual(failures.map(error => error.message), ['the sink threw'])
    assert.deepEqual(emitted, chunks)
    // The decision that failed is the one being published, so it is the only one
    // recorded; nothing behind it was decided at all.
    assert.deepEqual(findings, [{ index: 1, type: 'text', verdict: 'keep', reason: 'content-present' }])
  })

  it('never decides twice for one block when a decision is re-entered', () => {
    // `settle()` unlocks slots and reports; a second close for the same index must
    // not publish a second finding, or the counters would count chunks.
    const findings = []
    const gate = new EmptyBlockGate({
      types: ['reasoning'],
      apply: true,
      onFinding: finding => findings.push(finding),
    })
    gate.offer({ type: 'block-start', index: 0, blockType: 'reasoning' })
    gate.offer({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } })
    gate.offer({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } })
    gate.finish()
    assert.equal(findings.length, 1)
  })

  it('lets the consumer abandon the stream without settling anything', async () => {
    // An abandoned stream settles nothing and reports no envelope: there are no
    // more chunks to emit, and the harness discards the content of an interrupted
    // attempt anyway.
    const chunks = [...reasoning('checking', 0), finishWith(undefined)]
    const findings = []
    const envelopes = []
    const iterable = guardChunks(streamOf(chunks), {
      types: ['reasoning'],
      apply: true,
      onFinding: finding => findings.push(finding),
      onEnvelope: report => envelopes.push(report),
    })
    for await (const chunk of iterable) {
      assert.equal(chunk.type, 'block-start')
      break
    }
    assert.deepEqual(findings, [{ index: 0, type: 'reasoning', verdict: 'keep', reason: 'content-present' }])
    assert.deepEqual(envelopes, [])
  })
})
