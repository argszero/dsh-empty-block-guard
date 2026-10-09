/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * this harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and a
 * mutation that does not compile is reported as TYPEFAIL, because it never
 * reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped — one
 * distinction it exists to make, removed one edit at a time. They are not
 * "does the test file import the module": each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a promise the package makes
 * that nothing checks.
 *
 * The arms this package would be *worthless* without are:
 *
 * - the **emptiness rule itself** — `text.length === 0` is the whole subject. An
 *   arm that reads an empty delta as content stops every removal, and the session
 *   the plugin exists for is poisoned exactly as before.
 * - the **close-after-content distinction** — a close is authoritative, so a
 *   close that contradicts already-emitted deltas has to lose the close and keep
 *   the block. An arm that keeps it poisons the session *and* discards text the
 *   model actually sent.
 * - the **envelope pairing** — dropping a block without dropping its entry at the
 *   same rank turns a loud 400 into silent signature loss, which is the quiet
 *   failure this plugin must never introduce. The integration suite measures it
 *   with the shipped `BlockAssembler`.
 * - the **rank, not the index** — the envelope is positional. Removing entry
 *   `index` instead of entry `rank` looks right on a two-block example and is
 *   wrong for every block that is not first.
 * - **`observe`** — the only way to measure before trusting. An arm that makes
 *   it act removes the operator's ability to see the decisions without taking
 *   them.
 * - **fail-open** — a guard whose bug breaks working model calls is worse than
 *   the failure it prevents.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=rank    # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The emptiness rule *is* the subject. Reading an empty delta as content
    // settles every block as a keep, and the block the plugin exists for goes
    // out exactly as the provider produced it.
    name: 'empty: an empty delta is read as content',
    file: 'src/stream.ts',
    edits: [['          if (chunk.text.length > 0) {', '          if (chunk.text.length >= 0) {']],
  },
  {
    // The same rule on the other evidence path: a delta-only block whose only
    // evidence is an empty delta.
    name: 'empty: a delta-only block is settled by an empty delta',
    file: 'src/stream.ts',
    edits: [["        if (chunk.text.length > 0) this.settle(tracked, 'keep', 'content-present')",
      "        if (chunk.text.length >= 0) this.settle(tracked, 'keep', 'content-present')"]],
  },
  {
    // The close is the evidence for the reported shape. A close that says the
    // text is empty has to drop the block, or #9239 is unchanged.
    name: 'empty: a close with empty text keeps the block it closes',
    file: 'src/stream.ts',
    edits: [["    if (text.length > 0) this.settle(tracked, 'keep', 'content-present')\n    else this.settle(tracked, 'drop', 'empty-close-while-held')",
      "    if (text.length > 0) this.settle(tracked, 'keep', 'content-present')\n    else this.settle(tracked, 'keep', 'content-present')"]],
  },
  {
    // A stream that ends with the block still open is the poisoned shape in its
    // other spelling: the assembler builds it from the deltas it accumulated,
    // which is the empty string.
    name: 'finish: a block still open at the end of the stream is kept',
    file: 'src/stream.ts',
    edits: [["      if (tracked.state === 'held') this.settle(tracked, 'drop', 'empty-open')",
      "      if (tracked.state === 'held') this.settle(tracked, 'keep', 'content-present')"]],
  },
  {
    // A close is authoritative — `assemble()` returns a closed block verbatim.
    // Keeping a close that contradicts already-emitted deltas makes the block
    // assemble empty *and* discards text the model did send.
    name: 'close: a close contradicting its own deltas is emitted anyway',
    file: 'src/stream.ts',
    edits: [["        if (!this.policy.apply) this.plain(chunk)\n        this.reportClose(tracked, 'drop', 'empty-close-after-content')",
      "        this.plain(chunk)\n        this.reportClose(tracked, 'keep', 'content-present')"]],
  },
  {
    // `apply: false` is the measuring posture. Ignoring it makes `observe` act,
    // which removes the only way to see the decisions without taking them.
    name: 'posture: a decision is applied even when the policy says not to',
    file: 'src/stream.ts',
    edits: [["    const dropping = verdict === 'drop' && this.policy.apply",
      "    const dropping = verdict === 'drop'"]],
  },
  {
    // Order is why the buffer exists. Releasing a held block before its
    // emptiness is settled puts it on its way to the consumer, and the decision
    // then has nothing left to remove.
    name: 'order: a held block is released before its emptiness is settled',
    file: 'src/stream.ts',
    edits: [['    while (this.buffer.length > 0 && this.buffer[0]?.held !== true) {',
      '    while (this.buffer.length > 0) {']],
  },
  {
    // The dropped index is what the envelope pruning looks up. Unregistering it
    // leaves the envelope carrying an entry for a block that no longer exists —
    // the count mismatch that costs the message every signature it had.
    name: 'envelope: a dropped block is not registered for pruning',
    file: 'src/stream.ts',
    edits: [['      this.vanished.add(tracked.index)', '      this.vanished.add(-1)']],
  },
  {
    // The envelope is positional. Removing the entry at `index` rather than at
    // the block's `rank` looks correct on a two-block message and is wrong for
    // every dropped block that is not the first.
    name: 'envelope: the entry is removed at the index rather than the rank',
    file: 'src/stream.ts',
    edits: [['      const rank = this.order.indexOf(index)', '      const rank = index']],
  },
  {
    // Dropping the block but keeping its entry is exactly the trade this plugin
    // refuses: the count no longer matches, and the assembler discards the whole
    // envelope instead of the one entry.
    name: 'envelope: the dropped block keeps its envelope entry',
    file: 'src/stream.ts',
    edits: [['    const blocks = envelope.blocks.filter((_, position) => !ranks.has(position))',
      '    const blocks = envelope.blocks']],
  },
  {
    // An envelope that never matched its own stream is already discarded by the
    // assembler. "Pruning" it by this stream's ranks rewrites metadata belonging
    // to something else, which is worse than the loss it hides.
    name: 'envelope: an envelope that never matched its stream is rewritten anyway',
    file: 'src/stream.ts',
    edits: [['    if (entries !== streamBlocks) {', '    if (entries === -1) {']],
  },
  {
    // The envelope carries one entry per *seen* block, in first-seen order, so
    // the count this gate compares against is the number of distinct indexes —
    // not the number of chunks that named one. Counting a repeated index twice
    // makes every envelope look unaligned.
    name: 'envelope: an index sighted twice is counted twice',
    file: 'src/stream.ts',
    edits: [['    if (this.seen.has(index)) return', '    if (this.seen.has(index) && this.vanished.size < 0) return']],
  },
  {
    // The configured types are the operator's instruction. A gate that guards
    // every text-bearing block regardless drops what nobody asked it to drop.
    name: 'types: the configured types are ignored and every text block is guarded',
    file: 'src/stream.ts',
    edits: [["    return (type === 'text' || type === 'reasoning') && this.policy.types.includes(type)",
      "    return type === 'text' || type === 'reasoning'"]],
  },
  {
    // A block reports its content verdict once. Without the guard the same block
    // reports at the moment it was released *and* again where its close arrived,
    // and the counters count chunks rather than blocks.
    name: 'report: a block publishes its content verdict more than once',
    file: 'src/stream.ts',
    edits: [['    if (tracked.reported) return', '    if (tracked.reported && this.vanished.size < 0) return']],
  },
  {
    // Fail-open: a failure inside the gate is this plugin's problem, not the
    // consumer's. Throwing it turns a guard bug into a broken model call — a
    // worse failure than the one it prevents.
    name: 'fail-open: a failure inside the gate is thrown to the consumer',
    file: 'src/stream.ts',
    edits: [['      failed = true\n      policy.onFailure?.(error)', '      policy.onFailure?.(error)\n      throw error']],
  },
  {
    // What the gate had taken is the authoritative copy once it has failed: the
    // chunks it was holding are the ones the consumer never saw, and abandoning
    // them truncates the stream.
    name: 'fail-open: what the failed gate was holding is dropped, not released',
    file: 'src/stream.ts',
    edits: [['      for (const emitted of gate.release()) yield emitted', '      for (const emitted of []) yield emitted']],
  },
  {
    // The end-of-stream pass is the only thing that settles a block the adapter
    // never closed. Skipping it leaves the block held forever, so it never
    // reaches the consumer and never leaves the envelope either.
    name: 'finish: the source ending does not settle the gate',
    file: 'src/stream.ts',
    edits: [['    gate.finish()\n    for (const emitted of gate.drain()) yield emitted',
      '    for (const emitted of gate.drain()) yield emitted']],
  },
  {
    // The listener position *is* the removal: only the outermost `llm/stream`
    // listener sees the stream the consumer (and the assembler) will consume.
    name: 'position: the guard no longer takes the outermost llm/stream boundary',
    file: 'src/index.ts',
    edits: [['  }, { global: true, prepend: true })', '  }, { global: true, prepend: false })']],
  },
  {
    // The stream is dispatched with the registry instance as the listener's
    // `this`, so a mount scoped to a profile stops covering it without `global`.
    name: 'position: the guard stops covering the registry-scoped dispatch',
    file: 'src/index.ts',
    edits: [['  }, { global: true, prepend: true })', '  }, { global: false, prepend: true })']],
  },
  {
    // `observe` exists so an operator can measure before trusting. Making it act
    // removes the only way to see the decisions without taking them.
    name: 'mode: observe applies the removal it exists to measure first',
    file: 'src/index.ts',
    edits: [["      apply: settings.mode === 'drop',", '      apply: true,']],
  },
  {
    // `off` is the mode that installs nothing. Installing anyway means an
    // operator who turned the guard off still has it rewriting their stream.
    // Written through `String` because `settings.mode` is the closed `GuardMode`
    // union: comparing it to a literal outside the union is a compile error, and
    // a mutation that does not compile never reaches the suite.
    name: 'mode: off installs a listener anyway',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') {", "  if (String(settings.mode) === '__off__') {"]],
  },
  {
    // Every decision is counted under the verdict that produced it; that is how
    // an operator reads back what the plugin refused to do. Folding them into one
    // bucket hides which rule fired.
    name: 'counters: every verdict is counted as a keep',
    file: 'src/index.ts',
    edits: [['        counters.verdicts[finding.verdict] += 1', '        counters.verdicts.keep += 1']],
  },
  {
    // An ordinary block that carried text is not a decision worth a log line or a
    // history entry — only the ones that needed something are.
    name: 'history: an ordinary block is recorded as a decision',
    file: 'src/index.ts',
    edits: [["        if (finding.reason === 'content-present') {", "        if (String(finding.reason) === '__never__') {"]],
  },
  {
    // The history is what an operator reads back after the fact, and the bound is
    // what keeps it from becoming a leak in a long session.
    name: 'history: retained decisions are never trimmed to the configured limit',
    file: 'src/index.ts',
    edits: [['    while (recent.length > settings.historyLimit) recent.shift()',
      '    while (recent.length > 10_000_000) recent.shift()']],
  },
  {
    // The disclosure is the difference between "nothing needed removing" and
    // "the removal never ran". Emptying it turns a statement into a silent
    // success.
    name: 'report: the blind spots the plugin cannot close are no longer stated',
    file: 'src/index.ts',
    edits: [['    notCovered: blindSpots(),', '    notCovered: [],']],
  },
  {
    // `observe`'s own log line states what the acting mode would do to the stream
    // instead. A measuring run that logs the acting verb is indistinguishable
    // from an acting one in the log an operator reads afterwards.
    name: 'report: the measuring mode logs the verb of the acting one',
    file: 'src/index.ts',
    edits: [["    case 'empty-close-while-held':\n      return mode === 'observe'",
      "    case 'empty-close-while-held':\n      return mode === 'off'"]],
  },
  {
    // The service is how a caller reads the counters. Providing it under another
    // name provides nothing.
    name: 'service: the snapshot service is provided under a name nobody reads',
    file: 'src/index.ts',
    edits: [['    ctx.provide(SERVICE, service)\n    return', "    ctx.provide('emptyBlockGuardValue', service)\n    return"]],
  },
  {
    // `off` installs no listener but must still look mounted; a plugin that
    // answered nothing at all is indistinguishable from one that failed to load.
    name: 'mode: off no longer provides the service, so the mount is invisible',
    file: 'src/index.ts',
    edits: [['    ctx.provide(SERVICE, service)\n    return', '    return']],
  },
  {
    // An unrecognised mode must be the one that changes nothing. A typo that
    // removes is a plugin acting when the operator asked it not to.
    name: 'config: a misspelled mode removes instead of holding back',
    file: 'src/config.ts',
    edits: [["  return 'observe'", "  return 'drop'"]],
  },
  {
    // The absent value is the default; only a *spelling* the plugin does not know
    // is held back. Conflating the two makes an unconfigured mount silently
    // measure instead of removing.
    name: 'config: an absent mode measures instead of taking the documented default',
    file: 'src/config.ts',
    edits: [['  if (value === undefined) return defaultConfig.mode', "  if (value === undefined) return 'observe'"]],
  },
  {
    // An entry this plugin does not implement is removed, not promoted to a
    // wildcard: `types: ['image']` asks for a guard that guards nothing, and
    // widening it would drop blocks the operator never asked about.
    name: 'config: an unimplemented type is kept instead of removed',
    file: 'src/config.ts',
    edits: [["  return (['text', 'reasoning'] as const).filter(type => wanted.has(type))",
      "  return [...wanted] as readonly ('text' | 'reasoning')[]"]],
  },
  {
    // Nonnegative integers only: `-1` and `1.5` are typos, not bounds.
    name: 'config: a history limit that is not a nonnegative integer is honoured',
    file: 'src/config.ts',
    edits: [["  return typeof value === 'number' && Number.isInteger(value) && value >= 0\n    ? Math.min(value, ceiling)\n    : fallback",
      "  return typeof value === 'number' ? value : fallback"]],
  },
  {
    // The ceiling is what bounds the retained history when an operator asks for
    // an unbounded one by accident.
    name: 'config: the history limit is no longer bounded by the ceiling',
    file: 'src/config.ts',
    edits: [['    ? Math.min(value, ceiling)', '    ? value']],
  },
  {
    // `report` gates every log line this plugin writes.
    name: 'config: the report flag is forced on regardless of configuration',
    file: 'src/config.ts',
    edits: [['    report: flag(config.report, defaultConfig.report),', '    report: true,']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a reader can leave the
 * suite waiting on something this package would otherwise bound, and a mutant
 * that never terminates is a mutant the suite cannot report on. It is killed
 * here and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug. Measured
  // in this family: one flat `edits: ['…', '…']` reported "the suite stayed
  // green" while the real mutation was never applied.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
