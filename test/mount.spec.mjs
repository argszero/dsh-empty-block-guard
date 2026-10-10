/**
 * The object a profile entry mounts, mounted.
 *
 * `vendor/loader` normalises a plugin module with `exports.default ?? exports`
 * and hands that object to `ctx.plugin`, which reads `Config['~standard'].validate`
 * off it whenever it carries a `Config`. The rest of this suite mounts the
 * *namespace* (`import * as plugin`), which has no `Config` of its own — so the
 * two mounts are one object apart, and only this file mounts the one a profile
 * entry reaches.
 *
 * That difference is not academic. This package used to export
 * `Config: defaultConfig` on its default export. `defaultConfig` is a plain
 * object, not a schema, so `Config['~standard']` was `undefined` and every mount
 * of the installed package died with
 * `TypeError: Cannot read properties of undefined (reading 'validate')` before a
 * line of `apply` ran — while this suite stayed green, because the namespace
 * import never carried that key.
 *
 * Both arms are kept: the invariant that a `Config` may only be a schema, and the
 * mount itself.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import plugin from '../lib/index.js'
import { world } from './harness.mjs'

test('a `Config` on the default export is a schema cordis can validate with', () => {
  const Config = plugin.Config
  if (Config === undefined) return
  assert.equal(
    typeof Config['~standard']?.validate,
    'function',
    'cordis calls Config["~standard"].validate at mount; a plain defaults object throws there',
  )
})

test('the default export mounts the way a loader entry mounts it', async () => {
  assert.equal(typeof plugin.apply, 'function', 'the default export is the plugin a loader resolves')
  // Every harness in this family mounts the plugin inside `world()` — the eager
  // ones inline, the lazy ones through their own `mount()`, which `world()` calls
  // before it returns — so reaching the next line is the whole assertion.
  await world({ plugin: 'default' })
})
