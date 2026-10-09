/**
 * Configuration, normalized once at mount.
 *
 * The knobs are the three questions an operator actually asks about a plugin
 * that rewrites a model's output stream: *how much should it do* (`mode`),
 * *which blocks does that mean* (`types`), *what did it do* (`report`), and *how
 * much of that can I read back* (`historyLimit`).
 *
 * @module @argszero/dsh-empty-block-guard/config
 */

/**
 * What the plugin does with a text or reasoning block whose text is empty.
 *
 * - `drop` removes it before the consumer — and therefore before the durable
 *   assistant message — sees it. This is the default: the block is not
 *   representable on the wire (`{ type: 'thinking', thinking: '' }`), a strict
 *   gateway rejects the whole request over it, and a session that has one in its
 *   log fails at the same message index on every later turn. There is no
 *   alternative that keeps the block *and* survives, because the only way an
 *   empty block can be made representable is to invent text for it.
 * - `observe` decides and counts exactly as `drop` would, and changes nothing.
 * - `off` installs no listener at all.
 */
export type GuardMode = 'drop' | 'observe' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /** Whether an empty block is dropped, only counted, or not looked for at all. */
  readonly mode?: GuardMode
  /** The block types to guard. Defaults to both the wire cannot spell empty. */
  readonly types?: readonly ('text' | 'reasoning')[]
  /** Log one line per decision at `info`. */
  readonly report?: boolean
  /** How many recent decisions `snapshot()` keeps. `0` keeps none. */
  readonly historyLimit?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: GuardMode
  readonly types: readonly ('text' | 'reasoning')[]
  readonly report: boolean
  readonly historyLimit: number
}

/**
 * The reference defaults, also the fallbacks used per field.
 *
 * A plain object rather than a schema: every value is a primitive or a short
 * list, and a plugin that failed to mount because a configuration library
 * disagreed about the spelling of `observe` would be a worse trade than one that
 * reads what it was given.
 *
 * `types` covers **both** text and reasoning, because the wire rejects an empty
 * member of either: `serialize.ts` writes `{ type: 'text', text: block.text }`
 * for one and `{ type: 'thinking', thinking: block.text }` for the other, and
 * neither an empty text block nor an empty thinking block is a request any strict
 * Anthropic-compatible gateway accepts. The reported defect is the reasoning one
 * — thinking blocks are the ones a provider can produce empty on its own, since a
 * model that is asked to think can decline to — but a guard that covered only
 * that half would leave the same session-killing shape one serializer line away.
 *
 * An **unrecognised** `mode` resolves to `observe` rather than to `drop`: the
 * failure mode of a typo has to be the one that changes nothing. That rule is
 * about the spelling, not about the absent value, which takes the default.
 */
export const defaultConfig: Required<Config> = {
  mode: 'drop',
  types: ['text', 'reasoning'],
  report: true,
  historyLimit: 20,
}

/** Read a bounded non-negative integer, falling back for anything else. */
function count(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, ceiling)
    : fallback
}

/** Read a boolean, falling back for anything else. */
function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Resolve a `mode`, keeping only the three spellings this plugin implements.
 * @param value - the configured mode, if any.
 * @returns the configured mode, the default when absent, or `observe` for anything unrecognised.
 */
function mode(value: GuardMode | undefined): GuardMode {
  if (value === undefined) return defaultConfig.mode
  if (value === 'drop' || value === 'observe' || value === 'off') return value
  return 'observe'
}

/**
 * Resolve the guarded types, dropping anything unrecognised.
 *
 * An entry this plugin does not implement is removed rather than treated as a
 * wildcard, and a list that resolves to nothing is left empty — an operator who
 * writes `types: ['image']` has asked for a guard that guards nothing, and
 * silently widening that to every text block would drop blocks they never asked
 * about. `off` is the honest way to say "guard nothing", and an empty list means
 * the same thing without uninstalling.
 * @param value - the configured types, if any.
 * @returns the guarded types, de-duplicated and in a stable order.
 */
function types(value: readonly ('text' | 'reasoning')[] | undefined): readonly ('text' | 'reasoning')[] {
  if (value === undefined) return defaultConfig.types
  const wanted = new Set(value)
  return (['text', 'reasoning'] as const).filter(type => wanted.has(type))
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    mode: mode(config.mode),
    types: types(config.types),
    report: flag(config.report, defaultConfig.report),
    historyLimit: count(config.historyLimit, defaultConfig.historyLimit, 512),
  }
}
