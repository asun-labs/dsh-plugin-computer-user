/**
 * smoke-host.mjs — load the built host bundle the way the DSH host will.
 *
 * The type checker and the tests both read `src/`. This checks the artifact the
 * app actually loads: that `lib/index.js` imports cleanly on Node with only the
 * declared peer dependencies present, exports the shape the plugin loader looks
 * for, and that its settings schema parses to the defaults the panel expects.
 *
 * Catches the class of failure where a build succeeds but the bundle reaches for
 * something that is not there at runtime.
 *
 * Run: node scripts/smoke-host.mjs
 */

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib', 'index.js')

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log(`smoke: ${entry}`)
if (!existsSync(entry)) {
  console.error('lib/index.js is missing — run `pnpm run build` first')
  process.exit(1)
}

const module = await import(pathToFileURL(entry).href)

// ── the plugin contract ─────────────────────────────────────────────────────
check('exports a stable name', module.name === 'dsh-computer-user', `got ${String(module.name)}`)
check('declares its services', Array.isArray(module.inject) && module.inject.includes('tools') && module.inject.includes('connection'),
  `got ${JSON.stringify(module.inject)}`)
check('exports apply()', typeof module.apply === 'function')
check('exports a settings schema', typeof module.Config === 'function' || typeof module.Config === 'object')
check('names the settings namespace', module.NS === 'computer-user', `got ${String(module.NS)}`)
check('has a default export', module.default !== undefined)
check('default export carries Config for DSH 0.2 forms', module.default?.Config === module.Config)

// ── the settings defaults the panel reads ───────────────────────────────────
// The schema is the user-visible contract: a wrong default here silently changes
// whether the agent acts on the real desktop. Schemastery schemas are callable,
// and calling one resolves the defaults.
let parsed
try {
  parsed = module.Config({})
} catch (cause) {
  check('settings schema parses', false, String(cause?.message ?? cause))
}
check('settings schema parses', parsed !== undefined)
const plain = value => value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
check('link_mode defaults to virtual', plain(parsed?.link_mode) === 'virtual', `got ${String(plain(parsed?.link_mode))}`)
check('mode defaults to manual', plain(parsed?.mode) === 'manual', `got ${String(plain(parsed?.mode))}`)
check('capture interval defaults to a sane cadence', plain(parsed?.capture_interval_ms) === 1500, `got ${String(plain(parsed?.capture_interval_ms))}`)
check('output guard defaults on', plain(parsed?.output_guard) === true, `got ${String(plain(parsed?.output_guard))}`)

// ── the PowerShell scripts the host shells out to ───────────────────────────
// These are not bundled into lib/, so a packaging mistake would only surface at
// the first screenshot — i.e. in the user's face rather than here.
for (const script of ['capture.ps1', 'input.ps1']) {
  check(`src/${script} is present for the built bundle`, existsSync(join(root, 'src', script)))
}

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
