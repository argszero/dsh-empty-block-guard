#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins **the whole line**,
 * installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the range is one line, and its **newest** published build
 * is the representative: the earliest build of a line is an alpha nobody is left
 * on, and probing it says less than probing the build the line converged to.
 *
 * Three rules this probe follows, because violating any of them measures the
 * probe rather than the line:
 *
 * 1. **The whole line is pinned, not the packages this plugin happens to
 *    import.** The set of harness packages a line carries grows between lines,
 *    so it is read from the line's own manifests rather than written down here:
 *    the closure starts at every `@deepseek-ai/dsh-*` this package declares and
 *    at the peers of that line's `@deepseek-ai/dsh-agent`, then widens along each
 *    package's own `peerDependencies` until it stops growing. A subset left
 *    unwritten is a subset npm is free to resolve from another line, and the
 *    resulting tree is then not the line.
 *
 *    This matters for *this* package in a way it does not for most: nothing in
 *    `src/` imports a harness package for value — every one of those imports is
 *    type-only and erased — so what the suite actually exercises is a **real**
 *    `LlmRuntime` from `@deepseek-ai/dsh-llm` inside a real `Context` from
 *    `@deepseek-ai/cordis`, the real `llm/stream` waterfall dispatch, and the
 *    shipped `BlockAssembler` that reads the chunks this gate emits and decides
 *    what the replay envelope is worth. A tree that mixed two lines would let the
 *    assembler and the gate disagree about the shape of a `StreamChunk`, and the
 *    seam assertion — "the message the gateway refused is sendable, and the kept
 *    blocks keep their signatures" — would be measuring the mixture.
 * 2. **`--legacy-peer-deps`.** Without it npm derives peers transitively and can
 *    install a second line's copy of a package to satisfy them — again a tree
 *    that is not the line. The installation is `npm ci`-free on purpose: there
 *    is no lockfile to honour, the pins *are* the specification.
 * 3. **Every pinned package's version is read back after install.** A pin that
 *    silently did not apply is the failure mode this whole script exists to
 *    prevent, so it is asserted rather than assumed, and the assertion runs
 *    before the suite so a mixed tree can never be reported as a passing line.
 *
 * ```sh
 * npm run test:probe-lines                 # every line the range admits
 * npm run test:probe-lines -- 0.2.0-rc.2   # one line
 * npm run test:probe-lines -- --keep       # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED_LINES` contract in `test/packaging.spec.mjs`) rather than left
 * claimed. This script is development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * The package whose own manifest is the line's canonical peer list.
 *
 * Read because the set of harness packages a line carries is not derivable from
 * this plugin's own imports — which are all type-only and erased: the probe tree
 * installs a graph, and the graph's shape is the line's business, not this
 * package's.
 */
const LINE_MANIFEST = '@deepseek-ai/dsh-agent'

/**
 * How many `peerDependencies` fields one line's closure is willing to read.
 *
 * A guard, not a budget: the closure is a fixed point over the line's own
 * metadata, and a bound that is hit means the metadata is not the shape this
 * script assumes. Reported when reached rather than silently truncating, because
 * a truncated closure is a hole in "the whole line" that would be invisible.
 */
const CLOSURE_LIMIT = 80

/**
 * `@deepseek-ai/cordis` and its plugins are deliberately NOT pinned to the line:
 * their versions do not follow the harness's line numbering, so they are
 * installed at whatever range the line's own manifests ask for. Named here so
 * the distinction is visible rather than an accident of a prefix filter.
 *
 * They still have to be *installed*. They arrive as `peerDependencies` of the
 * dsh packages, and `--legacy-peer-deps` (the second rule below) means npm does
 * not install peers — so a tree built from the pins alone cannot load
 * `dsh-llm`, whose own import of `@deepseek-ai/cordis-plugin-loader` then fails
 * with `ERR_MODULE_NOT_FOUND`. The ranges are read from the line, not written
 * down here, for the same reason the pin set is.
 */
const NOT_LINE_NUMBERED = [/^@deepseek-ai\/cordis$/, /^@deepseek-ai\/cordis-plugin-/]

/** Whether a package name follows the harness's line numbering. */
function isLineNumbered(name) {
  return name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/dsh'
}

/**
 * The newest published build of each `||` segment of a range.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

/**
 * Every `@deepseek-ai/dsh-*` package one line carries, read from that line's own
 * manifests and closed over their `peerDependencies`.
 *
 * Read rather than written down: the set grows between lines, so a list here
 * would be a second, silently stale copy of the contract — and the packages it
 * left out would be resolved from whatever line npm prefers.
 * @param line - the line to read.
 * @param log - the progress writer.
 * @returns the package names, and the ranges the line asks for its non-line-numbered peers.
 */
function linePackages(line, log) {
  const names = new Set()
  /** Name → the range a line manifest asked for, for packages not line-numbered. */
  const ranged = new Map()
  const pending = [LINE_MANIFEST, ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
    .filter(name => name.startsWith('@deepseek-ai/'))
  let read = 0
  const visit = name => {
    if (names.has(name)) return false
    if (NOT_LINE_NUMBERED.some(pattern => pattern.test(name))) return false
    names.add(name)
    return true
  }
  while (pending.length > 0) {
    const name = pending.shift()
    if (!visit(name)) continue
    if (read >= CLOSURE_LIMIT) {
      log(`    WARNING: the line closure hit its ${CLOSURE_LIMIT}-package bound with ${pending.length} still unread — the pin set is incomplete`)
      break
    }
    read += 1
    try {
      const raw = execFileSync(
        'npm', ['view', `${name}@${line}`, 'peerDependencies', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const peers = JSON.parse(raw || '{}')
      for (const peer of Object.keys(peers)) {
        if (!peer.startsWith('@deepseek-ai/')) continue
        if (NOT_LINE_NUMBERED.some(pattern => pattern.test(peer))) {
          const range = peers[peer]
          // First sighting wins. A second, different range for the same name is
          // reported rather than silently merged: widening it here would install
          // a version no single line manifest asked for.
          if (!ranged.has(peer)) ranged.set(peer, range)
          else if (ranged.get(peer) !== range) log(`    note: ${peer} is asked for as ${ranged.get(peer)} and ${range}; using ${ranged.get(peer)}`)
          continue
        }
        if (!names.has(peer)) pending.push(peer)
      }
    } catch {
      // A line that never shipped this package leaves it for `publishedAt` to
      // drop, with the count printed; nothing is decided here.
    }
  }
  return { names: [...names], ranged }
}

/** Whether one package has a build at exactly this line. */
function publishedAt(name, line) {
  try {
    execFileSync('npm', ['view', `${name}@${line}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * Install the pinned tree, then assert that the pins are what was installed.
 *
 * `--legacy-peer-deps` is the second rule in the header: without it npm derives
 * peer requirements transitively and can satisfy them with another line's copy.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param pins - the exact versions the tree was supposed to get.
 * @param line - the line being probed.
 */
function install(dir, log, pins, line) {
  const options = { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], options)
  const resolved = []
  for (const name of Object.keys(pins)) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
    resolved.push(`${name.replace('@deepseek-ai/dsh-', '')}@${installed}`)
    if (installed !== line) {
      throw new Error(`the pin did not apply: ${name} resolved to ${installed}, not ${line}`)
    }
  }
  log(`    pinned ${resolved.length}: ${resolved.join(' ')}`)
}

/** Install one probe and run the suite in it. */
function probe(line, keep) {
  const dir = mkdtempSync(join(tmpdir(), `empty-block-guard-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)

  const { names: declared, ranged } = linePackages(line, log)
  // A package the line never shipped cannot be pinned to it. Dropped rather
  // than silently resolved from another line: the count is printed, because a
  // dropped name is one hole in "the whole line" that the reader should see.
  // Only names the manifest itself declares are required to be present; a peer
  // of a peer that the line never shipped is simply not part of the line.
  const required = [...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))
  const published = new Set(declared.filter(name => publishedAt(name, line)))
  const missing = required.filter(name => !published.has(name))
  if (missing.length > 0) {
    log(`=== ${line}: FAIL — this package declares ${missing.join(', ')}, which the line never shipped`)
    return false
  }
  const names = [...published]
  const pins = Object.fromEntries(names.map(name => [name, line]))
  log(`    pinning ${names.length} harness packages${declared.length - names.length > 0 ? ` (${declared.length - names.length} in the closure not published at this line, left unpinned)` : ''}`)
  log(`    installing ${ranged.size} package(s) that are not line-numbered, at the range the line asks for: ${[...ranged].map(([name, range]) => `${name}@${range}`).join(' ')}`)

  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The pins live in `devDependencies` so the tree is exactly the line: the
    // peers are then satisfied by it, and nothing else is installed for them.
    devDependencies: { ...Object.fromEntries(ranged), ...manifest.devDependencies, ...pins },
    // No `test:probe-lines` here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)

  try {
    install(dir, log, pins, line)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies['@deepseek-ai/dsh-llm']
const published = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh-llm', 'versions', '--json'], { encoding: 'utf8' }))
const lines = requested.length > 0 ? requested : representativesOf(range, published)

const failed = lines.filter(line => !probe(line, keep))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and SUPPORTED_LINES\n`)
  process.exitCode = 1
}
