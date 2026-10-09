/**
 * Configuration: a knob is only a knob if a wrong value resolves to something
 * safe, and the rules that matter are which way a typo falls, which value an
 * absent setting takes, and — for `types` — that an entry this plugin does not
 * implement is removed rather than promoted to a wildcard.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultConfig, normalizeConfig } from '../lib/config.js'

describe('normalizeConfig', () => {
  it('resolves every default from an empty configuration', () => {
    assert.deepEqual(normalizeConfig({}), { mode: 'drop', types: ['text', 'reasoning'], report: true, historyLimit: 20 })
    assert.deepEqual(defaultConfig, { mode: 'drop', types: ['text', 'reasoning'], report: true, historyLimit: 20 })
  })

  it('keeps every mode it implements', () => {
    for (const mode of ['drop', 'observe', 'off']) {
      assert.equal(normalizeConfig({ mode }).mode, mode)
    }
  })

  it('falls back to measuring for a mode it does not implement', () => {
    // A misspelled mode must be the one that changes nothing: a plugin acting
    // when the operator asked it not to is worse than one that does nothing.
    assert.equal(normalizeConfig({ mode: 'repair' }).mode, 'observe')
    assert.equal(normalizeConfig({ mode: '' }).mode, 'observe')
  })

  it('takes the documented default for an absent mode', () => {
    assert.equal(normalizeConfig({}).mode, 'drop')
  })

  it('guards both text-bearing types by default', () => {
    // Both, because the wire refuses an empty member of either — the report is
    // about the reasoning half, and the text half is one serializer line away.
    assert.deepEqual(normalizeConfig({}).types, ['text', 'reasoning'])
  })

  it('keeps only the types it implements, in a stable order', () => {
    assert.deepEqual(normalizeConfig({ types: ['reasoning'] }).types, ['reasoning'])
    assert.deepEqual(normalizeConfig({ types: ['reasoning', 'text'] }).types, ['text', 'reasoning'])
    assert.deepEqual(normalizeConfig({ types: ['text', 'text'] }).types, ['text'])
  })

  it('removes a type it does not implement instead of widening to every type', () => {
    // `types: ['image']` asks for a guard that guards nothing. Treating the
    // unknown entry as a wildcard would drop blocks the operator never asked
    // about; an empty list is the honest reading, and `off` says it louder.
    assert.deepEqual(normalizeConfig({ types: ['image'] }).types, [])
    assert.deepEqual(normalizeConfig({ types: [] }).types, [])
  })

  it('accepts only a nonnegative integer history limit', () => {
    assert.equal(normalizeConfig({ historyLimit: 0 }).historyLimit, 0)
    assert.equal(normalizeConfig({ historyLimit: 5 }).historyLimit, 5)
    assert.equal(normalizeConfig({ historyLimit: -1 }).historyLimit, 20)
    assert.equal(normalizeConfig({ historyLimit: 1.5 }).historyLimit, 20)
    assert.equal(normalizeConfig({ historyLimit: Number.NaN }).historyLimit, 20)
  })

  it('bounds the history an operator asks for by accident', () => {
    assert.equal(normalizeConfig({ historyLimit: 10_000 }).historyLimit, 512)
  })

  it('reads only a boolean for the report flag', () => {
    assert.equal(normalizeConfig({ report: false }).report, false)
    assert.equal(normalizeConfig({ report: true }).report, true)
    assert.equal(normalizeConfig({ report: 'yes' }).report, true)
  })
})
