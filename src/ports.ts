/**
 * dsh-plugin-computer-user / ports.ts — the seams between the plugin and the OS.
 *
 * Every tool goes through a `DesktopPort`. Two implementations exist:
 *
 *   · `createRealPort` — the upstream behaviour: PowerShell scripts driving
 *     Win32 SendInput, so the agent genuinely moves this machine's cursor.
 *   · `createVirtualPort` — the fork's default: nothing reaches the OS, and
 *     every action is recorded in the VirtualSession for the panel to draw.
 *
 * Because both satisfy one interface, `link_mode` is a single swap and the
 * tools, the mode gate, and the overlay recording are identical in either mode.
 * Tests substitute a recording port and never touch a real machine.
 *
 * @module dsh-plugin-computer-user/ports
 */

import { join, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { powerShellScript, runPs } from './ps.ts'
import type { Frame, VirtualSession } from './session.ts'

/** A capture request, already resolved against settings and the session cwd. */
export interface CaptureRequest {
  /** Absolute output path for the PNG. */
  readonly outPath: string
  /** Fractional crop `[x0, y0, x1, y1]` in `0..1`, when the caller wanted a region. */
  readonly region?: readonly [number, number, number, number]
  /** Downscale in `0.1..1`. */
  readonly scale: number
  /** Abort signal from the tool call. */
  readonly signal?: AbortSignal
}

/** The raw result of one capture, before it is interpreted as a Frame. */
export interface CaptureResult {
  readonly path: string
  readonly width: number
  readonly height: number
  readonly virtualOffset: readonly [number, number]
  readonly scale: number
}

/** Mouse actions, as the tools express them. */
export type PointerAction =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'click'; readonly x: number; readonly y: number; readonly action: 'click' | 'right_click' | 'double_click' }
  | { readonly kind: 'scroll'; readonly x: number; readonly y: number; readonly direction: 'up' | 'down' | 'left' | 'right'; readonly clicks: number }
  | { readonly kind: 'drag'; readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly holdKeys: readonly string[] }

/** One port call's outcome: what to report to the model, and where the pointer ended up. */
export interface PointerResult {
  /** Cursor position after the action, in screen pixels. */
  readonly cursor: readonly [number, number]
  /** Present only when the action really ran, so `real` mode can be audited. */
  readonly real?: boolean
}

/**
 * Everything the tools need from the outside world. One method per side effect,
 * so a test port is a handful of stubs.
 */
export interface DesktopPort {
  readonly kind: 'virtual' | 'real'
  /** Capture the screen to a PNG and report its geometry. */
  capture(request: CaptureRequest): Promise<CaptureResult>
  /** Move, click, scroll, or drag. */
  pointer(action: PointerAction, signal?: AbortSignal): Promise<PointerResult>
  /** Type Unicode text at the current focus. */
  type(text: string, options: { readonly sendEnter: boolean; readonly intervalMs: number }, signal?: AbortSignal): Promise<{ readonly chars: number }>
  /** Send a key chord. */
  keypress(keys: readonly string[], signal?: AbortSignal): Promise<{ readonly keys: string }>
  /** Read the OS cursor position, in screen pixels. */
  cursorPosition(signal?: AbortSignal): Promise<readonly [number, number]>
}

/**
 * Build a {@link Frame} from a capture result and the viewport it came from.
 *
 * The viewport must be measured from the *virtual screen*, not the PNG: a
 * `region` crop makes the PNG a fraction of the screen, so taking its size as
 * the viewport would make every screen coordinate look out of bounds.
 * @param result - the capture's own report.
 * @param viewport - the virtual-screen size at capture time.
 * @param region - the fractional crop that was requested, if any.
 * @returns the frame to hand to the session.
 */
export function toFrame(
  result: CaptureResult,
  viewport: { width: number; height: number },
  region?: readonly [number, number, number, number],
): Frame {
  return {
    path: result.path,
    width: result.width,
    height: result.height,
    virtualOffset: result.virtualOffset,
    scale: result.scale,
    viewport,
    at: Date.now(),
    ...(region ? { region } : {}),
  }
}

/** A capture path under the configured directory, or the OS temp directory. */
export function capturePath(cwd: string, configuredDir: string): string {
  const dir = configuredDir.trim() ? pathResolve(cwd, configuredDir) : join(tmpdir(), 'computer-user')
  return join(dir, `shot-${Date.now()}-${randomBytes(4).toString('hex')}.png`)
}

/**
 * The virtual port: records what an action *would* have done and reports back
 * the geometry the tools need, without touching the OS.
 *
 * Captures still run for real, because the panel needs a genuine picture — that
 * is the read half of computer use, and it is safe. Only the write half is
 * withheld, which is the whole point of the mode.
 * @param session - the session whose board the panel draws.
 */
export function createVirtualPort(session: VirtualSession): DesktopPort {
  return {
    kind: 'virtual',
    async capture(request) {
      return runCapture(request)
    },
    async pointer(action) {
      switch (action.kind) {
        case 'move':
          session.moveCursor(action.x, action.y)
          return { cursor: [action.x, action.y] }
        case 'click':
          session.click(action.x, action.y, action.action)
          return { cursor: [action.x, action.y] }
        case 'scroll':
          session.moveCursor(action.x, action.y)
          session.click(action.x, action.y, `scroll:${action.direction}`)
          return { cursor: [action.x, action.y] }
        case 'drag':
          session.moveCursor(action.from[0], action.from[1])
          session.click(action.from[0], action.from[1], 'drag')
          session.moveCursor(action.to[0], action.to[1])
          session.click(action.to[0], action.to[1], 'drop')
          return { cursor: [action.to[0], action.to[1]] }
      }
    },
    async type(text, options) {
      session.typed(options.sendEnter ? `${text}⏎` : text)
      return { chars: [...text].length }
    },
    async keypress(keys) {
      session.keypress(keys)
      return { keys: keys.join('+') }
    },
    async cursorPosition() {
      // There is no virtual cursor until an action names one, and the panel is
      // the only observer — so the session's own pointer is the answer.
      const { x, y } = session.cursor
      return [x, y]
    },
  }
}

/**
 * The real port: upstream's behaviour, driving this machine through the bundled
 * PowerShell scripts.
 *
 * Actions still land in the session so the panel mirrors what happened, which
 * is what turns `real` mode from an invisible hijack into something the user
 * can watch.
 * @param session - the session whose board the panel draws.
 */
export function createRealPort(session: VirtualSession): DesktopPort {
  return {
    kind: 'real',
    async capture(request) {
      return runCapture(request)
    },
    async pointer(action, signal) {
      switch (action.kind) {
        case 'move': {
          const result = await runPs('input.ps1', { action: 'move', coordinate: [action.x, action.y] }, signal ? { signal } : {})
          const cursor = asPair(result.cursor, [action.x, action.y])
          session.moveCursor(cursor[0], cursor[1])
          session.setRealCursor(cursor[0], cursor[1])
          return { cursor, real: true }
        }
        case 'click': {
          const result = await runPs('input.ps1', { action: 'click', coordinate: [action.x, action.y], action2: action.action }, signal ? { signal } : {})
          const cursor = asPair(result.cursor, [action.x, action.y])
          session.click(cursor[0], cursor[1], action.action)
          session.setRealCursor(cursor[0], cursor[1])
          return { cursor, real: true }
        }
        case 'scroll': {
          await runPs('input.ps1', { action: 'scroll', coordinate: [action.x, action.y], direction: action.direction, clicks: action.clicks }, signal ? { signal } : {})
          session.moveCursor(action.x, action.y)
          return { cursor: [action.x, action.y], real: true }
        }
        case 'drag': {
          const result = await runPs('input.ps1', {
            action: 'drag',
            from: [action.from[0], action.from[1]],
            to: [action.to[0], action.to[1]],
            holdKeys: [...action.holdKeys],
          }, signal ? { signal } : {})
          const cursor = asPair(result.cursor, [action.to[0], action.to[1]])
          session.moveCursor(action.from[0], action.from[1])
          session.click(action.from[0], action.from[1], 'drag')
          session.moveCursor(cursor[0], cursor[1])
          session.setRealCursor(cursor[0], cursor[1])
          return { cursor, real: true }
        }
      }
    },
    async type(text, options, signal) {
      const result = await runPs('input.ps1', {
        action: 'type',
        text,
        sendEnter: options.sendEnter,
        typingIntervalMs: options.intervalMs,
      }, signal ? { signal } : {})
      session.typed(options.sendEnter ? `${text}⏎` : text)
      return { chars: Number(result.chars ?? [...text].length) }
    },
    async keypress(keys, signal) {
      const result = await runPs('input.ps1', { action: 'keypress', keys: [...keys] }, signal ? { signal } : {})
      session.keypress(keys)
      return { keys: String(result.keys ?? keys.join('+')) }
    },
    async cursorPosition(signal) {
      const result = await runPs('input.ps1', { action: 'getpos' }, signal ? { signal } : {})
      const cursor = asPair(result.cursor, [0, 0])
      session.setRealCursor(cursor[0], cursor[1])
      return cursor
    },
  }
}

/** Run `capture.ps1`, which is the same in both modes because reading is safe. */
async function runCapture(request: CaptureRequest): Promise<CaptureResult> {
  const result = await runPs('capture.ps1', {
    outPath: request.outPath,
    region: request.region ? [...request.region] : undefined,
    scale: request.scale,
  }, request.signal ? { signal: request.signal } : {})
  return {
    path: String(result.path ?? request.outPath),
    width: Number(result.width ?? 0),
    height: Number(result.height ?? 0),
    virtualOffset: asPair(result.virtual_offset, [0, 0]),
    scale: Number(result.scale ?? request.scale),
  }
}

/** Coerce a PowerShell JSON array into a two-element tuple. */
function asPair(value: unknown, fallback: readonly [number, number]): [number, number] {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0])
    const y = Number(value[1])
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y]
  }
  return [fallback[0], fallback[1]]
}

/** The scripts this plugin depends on, for the debug log line. */
export const SCRIPT_PATHS = {
  capture: powerShellScript('capture.ps1'),
  input: powerShellScript('input.ps1'),
}
