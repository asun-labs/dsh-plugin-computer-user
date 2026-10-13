/**
 * dsh-plugin-computer-user / ps.ts — the bundled PowerShell runner.
 *
 * Ported from upstream `computer-user`'s `src/ps.js`; the protocol is unchanged
 * because it is a good one: the payload travels as base64 JSON (so no shell
 * quoting or encoding can corrupt CJK text), the script prints exactly one JSON
 * object carrying a boolean `ok`, and anything else on stdout is tolerated.
 *
 * @module dsh-plugin-computer-user/ps
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Absolute path to one of the bundled PowerShell scripts.
 *
 * The `.ps1` files live in `src/` and the build does not copy them, so this
 * checks beside the module first (a test run, where the module IS `src/`) and
 * then the sibling `src/` (the published layout, where the module is
 * `lib/index.js` and the package ships `src/*.ps1`).
 * @param name - `capture.ps1` or `input.ps1`.
 * @returns the absolute script path.
 * @throws when neither layout holds the script, which means a broken package rather than a runtime condition.
 */
export function powerShellScript(name: string): string {
  const candidates = [join(here, name), join(here, '..', 'src', name)]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] as string
}

/** The parsed JSON object a script printed. */
export type PsResult = Record<string, unknown>

/** Options for one script run. */
export interface PsOptions {
  /** Kill the child after this long. Defaults to 25s, which covers a slow full-screen grab. */
  readonly timeoutMs?: number
  /** Abort the run when the tool call is cancelled. */
  readonly signal?: AbortSignal
}

/**
 * Run a bundled script with a JSON payload.
 * @param scriptName - `capture.ps1` or `input.ps1`.
 * @param payload - the JSON payload object.
 * @param options - timeout and cancellation.
 * @returns the script's `ok: true` result object.
 * @throws when the script reports `ok: false`, exits without JSON, times out, or the call is aborted.
 */
export function runPs(scriptName: string, payload: object, options: PsOptions = {}): Promise<PsResult> {
  const { timeoutMs = 25_000, signal } = options
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(payload ?? {}), 'utf8').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powerShellScript(scriptName), '-Json', encoded],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    let settled = false

    const finish = (fn: (value: never) => void, value: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value as never)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`computer-use: PowerShell ${scriptName} 执行超时（${timeoutMs}ms）`))
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        child.kill()
        finish(reject, new Error('computer-use: 已取消'))
        return
      }
      signal.addEventListener('abort', () => {
        child.kill()
        finish(reject, new Error('computer-use: 已取消'))
      }, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => { out += chunk })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk })

    child.on('error', (cause: Error) => {
      finish(reject, new Error(`computer-use: 无法启动 PowerShell：${cause.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      // The JSON is the last thing printed, but banners can follow it, so scan
      // backwards for the first line that parses and carries an `ok` flag.
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (line === undefined) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed && typeof parsed === 'object' && 'ok' in parsed && typeof (parsed as PsResult).ok === 'boolean') {
          const result = parsed as PsResult
          if (result.ok) { resolve(result); return }
          reject(new Error(`computer-use: ${String(result.error ?? 'PowerShell 执行失败')}`))
          return
        }
      }
      const detail = err.trim()
      reject(new Error(
        `computer-use: ${scriptName} 失败（exit ${code}）` + (detail ? `：${detail.slice(0, 300)}` : '（无输出）'),
      ))
    })

    child.stdin.end()
  })
}

export default runPs
