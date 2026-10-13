/**
 * tools.spec.ts — the gate, the ports, and the two new tools.
 *
 * Everything here runs against a recording port and a real VirtualSession, so
 * no test touches the OS. That is the point of the port split: the fork's
 * promise ("the agent plays on the panel, not on your desk") is testable rather
 * than merely asserted.
 */

import { describe, expect, it } from 'vitest'
import { createComputerTools, modeGate, type ToolDeps } from '../src/tools.ts'
import { createVirtualPort, type DesktopPort, type PointerAction } from '../src/ports.ts'
import { VirtualSession, type Frame } from '../src/session.ts'
import { SETTINGS_DEFAULTS, resolveSettings, type Settings } from '../src/config.ts'

/** A port that answers every call with fixed geometry and records what it was asked to do. */
function recordingPort(): DesktopPort & { calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = []
  return {
    kind: 'virtual',
    calls,
    async capture() {
      calls.push({ method: 'capture', args: undefined })
      return { path: '/tmp/x.png', width: 1920, height: 1080, virtualOffset: [0, 0], scale: 1 }
    },
    async pointer(action: PointerAction) {
      calls.push({ method: 'pointer', args: action })
      const at = action.kind === 'drag' ? action.to : [action.x, action.y]
      return { cursor: [at[0], at[1]] }
    },
    async type(text, options) {
      calls.push({ method: 'type', args: { text, options } })
      return { chars: [...text].length }
    },
    async keypress(keys) {
      calls.push({ method: 'keypress', args: keys })
      return { keys: keys.join('+') }
    },
    async cursorPosition() {
      calls.push({ method: 'cursorPosition', args: undefined })
      return [7, 8]
    },
  }
}

function deps(overrides: Partial<ToolDeps> = {}, settings: Partial<Settings> = {}): { deps: ToolDeps; port: ReturnType<typeof recordingPort>; session: VirtualSession } {
  const port = recordingPort()
  const session = new VirtualSession()
  const resolved = resolveSettings({ ...SETTINGS_DEFAULTS, mode: 'auto', ...settings })
  const base: ToolDeps = {
    getSettings: () => resolved,
    port: () => port,
    session,
    approvedSessions: new Set<string>(),
    sessionIds: ['session-1'],
    setMode: async () => undefined,
    setLinkMode: async () => undefined,
    capture: async () => {
      const frame: Frame = {
        path: '/tmp/x.png',
        width: 1920,
        height: 1080,
        virtualOffset: [0, 0],
        scale: 1,
        viewport: { width: 1920, height: 1080 },
        at: 1,
      }
      session.setFrame(frame)
      return frame
    },
  }
  return { deps: { ...base, ...overrides }, port, session }
}

/** A minimal execution context; the tools read only `signal` and the session cwd. */
function exec(): never {
  return { callId: 'c1', name: 't', arguments: {}, signal: new AbortController().signal } as never
}

async function call(tool: { execute: (args: never, exec: never) => Promise<unknown> }, args: unknown): Promise<unknown> {
  return tool.execute(args as never, exec())
}

describe('modeGate', () => {
  const noApproval = new Set<string>()

  it('refuses everything when disabled', () => {
    expect(() => modeGate(resolveSettings({ mode: 'disabled' }), 'computer_screenshot', noApproval, ['s']))
      .toThrow(/已禁用/)
  })

  it('allows only read-only tools in readonly mode', () => {
    const settings = resolveSettings({ mode: 'readonly' })
    expect(() => modeGate(settings, 'computer_screenshot', noApproval, ['s'])).not.toThrow()
    expect(() => modeGate(settings, 'computer_get_vision', noApproval, ['s'])).not.toThrow()
    expect(() => modeGate(settings, 'computer_click', noApproval, ['s'])).toThrow(/只读模式/)
  })

  it('requires approval for acting tools in manual mode', () => {
    const settings = resolveSettings({ mode: 'manual' })
    expect(() => modeGate(settings, 'computer_click', noApproval, ['s'])).toThrow(/需要批准/)
    expect(() => modeGate(settings, 'computer_click', new Set(['s']), ['s'])).not.toThrow()
  })

  it('marks the approval error so the host can prompt instead of failing', () => {
    try {
      modeGate(resolveSettings({ mode: 'manual' }), 'computer_click', noApproval, ['s'])
      expect.unreachable('should have thrown')
    } catch (cause) {
      expect((cause as { awaitingApproval?: boolean }).awaitingApproval).toBe(true)
    }
  })

  it('does not require approval for read-only tools in manual mode', () => {
    expect(() => modeGate(resolveSettings({ mode: 'manual' }), 'computer_screenshot', noApproval, ['s'])).not.toThrow()
  })

  it('lets approval through for any of the session identities', () => {
    const settings = resolveSettings({ mode: 'manual' })
    expect(() => modeGate(settings, 'computer_click', new Set(['header-id']), ['agent-id', 'header-id'])).not.toThrow()
  })

  it('refuses mode changes unless the AI is allowed to make them', () => {
    const settings = resolveSettings({ mode: 'auto', ai_can_change_mode: false })
    expect(() => modeGate(settings, 'computer_set_mode', noApproval, ['s'])).toThrow(/未允许 AI 修改模式/)
    expect(() => modeGate(settings, 'computer_set_link_mode', noApproval, ['s'])).toThrow(/未允许 AI 修改模式/)
  })

  it('allows mode changes when enabled, even in disabled mode', () => {
    // Otherwise a disabled plugin could never be re-enabled by the user through
    // the agent, which is the one escape hatch worth keeping open.
    const settings = resolveSettings({ mode: 'disabled', ai_can_change_mode: true })
    expect(() => modeGate(settings, 'computer_set_mode', noApproval, ['s'])).not.toThrow()
  })
})

describe('createComputerTools', () => {
  it('registers every upstream tool plus the two the panel needs', () => {
    const { deps: toolDeps } = deps()
    const names = createComputerTools(toolDeps).map(tool => tool.name)
    expect(names).toEqual([
      'computer_screenshot',
      'computer_click',
      'computer_type',
      'computer_keypress',
      'computer_scroll',
      'computer_drag',
      'computer_move_mouse',
      'computer_wait',
      'computer_get_cursor_position',
      'computer_get_vision',
      'computer_set_mode',
      'computer_set_link_mode',
    ])
  })

  it('routes a click through the port at the given coordinate', async () => {
    const { deps: toolDeps, port } = deps()
    const click = createComputerTools(toolDeps).find(tool => tool.name === 'computer_click')
    const result = await call(click as never, { coordinate: [812, 430] })
    expect(port.calls.at(-1)).toEqual({ method: 'pointer', args: { kind: 'click', x: 812, y: 430, action: 'click' } })
    expect(result).toEqual({ clicked: [812, 430] })
  })

  it('defaults a click to the plain action and passes a right click through', async () => {
    const { deps: toolDeps, port } = deps()
    const click = createComputerTools(toolDeps).find(tool => tool.name === 'computer_click')
    await call(click as never, { coordinate: [1, 2], action: 'right_click' })
    expect(port.calls.at(-1)?.args).toMatchObject({ action: 'right_click' })
  })

  it('lets the type validator reject a malformed coordinate before the port is reached', async () => {
    const { deps: toolDeps, port } = deps()
    const click = createComputerTools(toolDeps).find(tool => tool.name === 'computer_click')
    await expect(call(click as never, { coordinate: ['a', 'b'] })).rejects.toThrow(/invalid arguments/)
    expect(port.calls).toHaveLength(0)
  })

  it('rejects a missing coordinate before reaching the port', async () => {
    const { deps: toolDeps, port } = deps()
    const click = createComputerTools(toolDeps).find(tool => tool.name === 'computer_click')
    await expect(call(click as never, {})).rejects.toThrow(/invalid arguments/)
    expect(port.calls).toHaveLength(0)
  })

  it('passes the configured typing interval and enter flag', async () => {
    const { deps: toolDeps, port } = deps({}, { typing_interval_ms: 25 })
    const type = createComputerTools(toolDeps).find(tool => tool.name === 'computer_type')
    await call(type as never, { text: '你好', send_enter: true })
    expect(port.calls.at(-1)?.args).toMatchObject({ text: '你好', options: { sendEnter: true, intervalMs: 25 } })
  })

  it('falls back to the configured scroll units', async () => {
    const { deps: toolDeps, port } = deps({}, { scroll_units: 3 })
    const scroll = createComputerTools(toolDeps).find(tool => tool.name === 'computer_scroll')
    await call(scroll as never, { coordinate: [5, 5] })
    expect(port.calls.at(-1)?.args).toMatchObject({ kind: 'scroll', direction: 'down', clicks: 3 })
  })

  it('reports both drag endpoints from the port', async () => {
    const { deps: toolDeps } = deps()
    const drag = createComputerTools(toolDeps).find(tool => tool.name === 'computer_drag')
    const result = await call(drag as never, { start_coordinate: [10, 10], end_coordinate: [90, 90] })
    expect(result).toEqual({ from: [10, 10], to: [90, 90] })
  })

  it('exposes the panel geometry and the user instructions through get_vision', async () => {
    const { deps: toolDeps, session } = deps()
    // The frame normally arrives from a capture; install one directly so the
    // test isolates what get_vision reports rather than how a frame is made.
    session.setFrame({
      path: '/tmp/x.png',
      width: 1920,
      height: 1080,
      virtualOffset: [0, 0],
      scale: 1,
      viewport: { width: 1920, height: 1080 },
      at: 1,
    })
    session.hint(640, 360, '看这里')
    const vision = createComputerTools(toolDeps).find(tool => tool.name === 'computer_get_vision')
    const result = await call(vision as never, {}) as Record<string, unknown>
    expect(result.frame).toMatchObject({ size: [1920, 1080], virtual_offset: [0, 0], scale: 1 })
    expect(result.user_instructions).toEqual([
      expect.objectContaining({ coordinate: [640, 360], note: '看这里' }),
    ])
  })

  it('persists a link-mode change through the hook', async () => {
    const seen: string[] = []
    const { deps: toolDeps } = deps({
      setLinkMode: async (mode) => { seen.push(mode) },
    }, { ai_can_change_mode: true })
    const setLink = createComputerTools(toolDeps).find(tool => tool.name === 'computer_set_link_mode')
    const result = await call(setLink as never, { link_mode: 'real' })
    expect(seen).toEqual(['real'])
    expect(result).toEqual({ link_mode: 'real', changed_by: 'ai' })
  })

  it('refuses a link-mode change when the AI is not allowed to make it', async () => {
    const { deps: toolDeps } = deps({}, { ai_can_change_mode: false })
    const setLink = createComputerTools(toolDeps).find(tool => tool.name === 'computer_set_link_mode')
    await expect(call(setLink as never, { link_mode: 'real' })).rejects.toThrow(/未允许 AI 修改模式/)
  })
})

describe('createVirtualPort', () => {
  it('records the actions instead of touching the machine', async () => {
    const session = new VirtualSession()
    const port = createVirtualPort(session)
    expect(port.kind).toBe('virtual')
    await port.pointer({ kind: 'click', x: 100, y: 200, action: 'click' })
    expect(session.cursor).toEqual({ x: 100, y: 200 })
    expect(session.snapshot().overlays.at(-1)).toMatchObject({ kind: 'click', x: 100, y: 200 })
  })

  it('reports the session cursor as the pointer position', async () => {
    const session = new VirtualSession()
    session.moveCursor(44, 55, { trail: false })
    const port = createVirtualPort(session)
    expect(await port.cursorPosition()).toEqual([44, 55])
  })

  it('records a drag as a press at the start and a drop at the end', async () => {
    const session = new VirtualSession()
    const port = createVirtualPort(session)
    const result = await port.pointer({ kind: 'drag', from: [1, 1], to: [9, 9], holdKeys: [] })
    expect(result.cursor).toEqual([9, 9])
    const overlays = session.snapshot().overlays
    expect(overlays.some(overlay => overlay.action === 'drag' && overlay.x === 1)).toBe(true)
    expect(overlays.some(overlay => overlay.action === 'drop' && overlay.x === 9)).toBe(true)
  })

  it('records typed text for the panel to draw', async () => {
    const session = new VirtualSession()
    const port = createVirtualPort(session)
    await port.type('hi', { sendEnter: true, intervalMs: 0 })
    expect(session.snapshot().overlays.at(-1)?.text).toBe('hi⏎')
  })
})

describe('resolveSettings', () => {
  it('returns the defaults for no snapshot', () => {
    expect(resolveSettings(undefined)).toEqual(SETTINGS_DEFAULTS)
  })

  it('defaults the link mode to virtual — the fork\'s whole point', () => {
    expect(SETTINGS_DEFAULTS.link_mode).toBe('virtual')
    expect(resolveSettings({}).link_mode).toBe('virtual')
  })

  it('ignores wrong-typed and out-of-enum values from a hand-edited file', () => {
    const resolved = resolveSettings({ mode: 'nonsense' as never, link_mode: 7 as never, capture_interval_ms: 'x' as never })
    expect(resolved.mode).toBe('manual')
    expect(resolved.link_mode).toBe('virtual')
    expect(resolved.capture_interval_ms).toBe(SETTINGS_DEFAULTS.capture_interval_ms)
  })

  it('keeps valid overrides', () => {
    const resolved = resolveSettings({ mode: 'auto', link_mode: 'real', capture_interval_ms: 0 })
    expect(resolved.mode).toBe('auto')
    expect(resolved.link_mode).toBe('real')
    expect(resolved.capture_interval_ms).toBe(0)
  })
})
