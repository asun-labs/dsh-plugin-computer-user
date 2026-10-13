/**
 * dsh-plugin-computer-user / tools.ts — the `computer_*` tool set.
 *
 * Everything upstream exposes, plus the two the visualization needs:
 *
 *   · `computer_get_vision` — the coordinate map, in words. The agent sees the
 *     same snapshot in the sidebar that the picture reader sees, and this turns
 *     that snapshot into numbers: the PNG size, the virtual-screen origin, the
 *     scale, the current pointer, and whatever the user has pointed at. It is
 *     the difference between "click the button in the picture" and "click
 *     [812, 430]".
 *   · `computer_set_link_mode` — the switch between acting on the sidebar and
 *     acting on the real desktop, gated like `computer_set_mode` so the agent
 *     cannot move the goalposts on its own initiative.
 *
 * Every side effect goes through a {@link DesktopPort}, so a tool never knows
 * whether the action will land on the real machine.
 *
 * @module dsh-plugin-computer-user/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LinkMode, RunMode, Settings } from './config.ts'
import type { DesktopPort } from './ports.ts'
import type { Frame, VirtualSession } from './session.ts'

/** Tools with no side effect on the desktop, allowed in read-only mode. */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  'computer_screenshot',
  'computer_get_cursor_position',
  'computer_get_vision',
  'computer_wait',
])

/** Screen-pixel coordinate pair, relative to the virtual-screen origin. */
const COORD = {
  type: 'array',
  items: { type: 'number' },
  description: '相对多屏虚拟屏原点的像素坐标 [x, y]（原点见 computer_screenshot / computer_get_vision 返回的 virtual_offset）',
} as const

/** The same coordinate, required — the declared shape of most pointer tools. */
const COORD_REQUIRED = { ...COORD, required: true } as const

/** The corrective preamble every acting tool carries. */
const HEAD =
  '先调用 computer_screenshot（或用 computer_get_vision 读取精确坐标与用户指示），必要时用 picturereader 的 image_scan / image_ocr 分析，最后才执行本次操作。'

/** What the tool layer needs from the plugin body. */
export interface ToolDeps {
  /** Resolved settings, read fresh on every call so hot reload works. */
  readonly getSettings: () => Settings
  /** The port for the current `link_mode`; swapped when the user flips it. */
  readonly port: () => DesktopPort
  /** The shared board the sidebar renders. */
  readonly session: VirtualSession
  /** Sessions approved through `/computer`. */
  readonly approvedSessions: Set<string>
  /** Every session identity visible at call time. */
  readonly sessionIds: readonly string[]
  /** Persist a new run mode. */
  readonly setMode: (mode: RunMode) => Promise<void>
  /** Persist a new link mode. */
  readonly setLinkMode: (mode: LinkMode) => Promise<void>
  /** Capture now and install the frame, so the panel reflects an explicit screenshot too. */
  readonly capture: (options: {
    readonly path?: string
    readonly region?: readonly number[]
    readonly scale?: number
    readonly keepOverlays?: boolean
    readonly cwd?: string
    readonly signal?: AbortSignal
  }) => Promise<Frame>
}

/**
 * Validate a tool call against the run mode and the session's approval.
 *
 * Deliberately the same four modes as upstream — the difference this fork adds
 * is `link_mode`, which sits beside this gate rather than inside it: whether an
 * action may run, and where it lands, are separate questions.
 * @param settings - resolved settings.
 * @param toolName - the tool being called.
 * @param approved - sessions approved through `/computer`.
 * @param sessionIds - every session identity visible at call time.
 * @throws with `awaitingApproval` set when the user must run `/computer` first.
 */
export function modeGate(settings: Settings, toolName: string, approved: ReadonlySet<string>, sessionIds: readonly string[]): void {
  // Mode changes are checked first and separately, so `disabled` stays escapable:
  // with ai_can_change_mode on, the agent can still switch the plugin back on
  // rather than being locked out by the very setting it would need to change.
  if (toolName === 'computer_set_mode' || toolName === 'computer_set_link_mode') {
    if (settings.ai_can_change_mode !== true) {
      throw new Error(`${toolName}: 当前未允许 AI 修改模式（设置「AI 可自行修改运行模式」未开启）`)
    }
    return
  }
  if (settings.mode === 'disabled') {
    throw new Error('computer-user 已禁用：请在「设置 → 电脑操作」切换运行模式后再使用')
  }
  if (settings.mode === 'readonly' && !READONLY_TOOLS.has(toolName)) {
    throw new Error(`computer-user 只读模式：${toolName} 不允许执行，仅截图/读光标/读视觉信息/等待可用`)
  }
  if (settings.mode === 'manual' && !READONLY_TOOLS.has(toolName)) {
    const isApproved = sessionIds.some((id) => id.length > 0 && approved.has(id))
    if (!isApproved) {
      const error = new Error('需要批准：当前为手动批准模式。请在对话框输入 /computer 批准后重试（批准后本轮及后续轮次均可使用）。')
      Object.assign(error, { awaitingApproval: true })
      throw error
    }
  }
}

/**
 * The output shape for every tool here: an open object of already-formatted
 * facts, rendered as `key: value` lines so a text-only model reads the result
 * the same way upstream's does.
 */
const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const

function textOut(head?: string) {
  return {
    schema: OPEN_OBJECT,
    render: (_args: unknown, value: Record<string, unknown>) => {
      const lines: string[] = []
      if (head) lines.push(head)
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'ok' || entry === undefined || entry === null) continue
        lines.push(`${key}: ${JSON.stringify(entry)}`)
      }
      return [{ type: 'text' as const, text: lines.join('\n') }]
    },
  }
}

/**
 * Assemble the tool set.
 * @param deps - ports, settings, session, and the two persistence hooks.
 * @returns definitions ready for `ctx.tools.register`.
 */
export function createComputerTools(deps: ToolDeps): ToolDefinition[] {
  const { getSettings, port, session, approvedSessions, sessionIds, setMode, setLinkMode, capture } = deps

  const gate = (toolName: string): Settings => {
    const settings = getSettings()
    modeGate(settings, toolName, approvedSessions, sessionIds)
    return settings
  }

  /** A reminder of where this action will land, appended to every acting tool. */
  const linkNote = (): string => getSettings().link_mode === 'virtual'
    ? '【落点 virtual】本次操作只在右侧快照面板上演示，不触碰真实桌面，用户的鼠标与焦点不受影响。'
    : '【落点 real】本次操作会真正注入本机鼠标/键盘。'

  const screenshot = defineTool({
    name: 'computer_screenshot',
    description: [
      'Capture the whole virtual screen (all monitors) to a PNG and return its path, width, height, virtual_offset and scale.',
      'The same snapshot is pushed to the right-sidebar panel, so the user watches what you are looking at.',
      HEAD,
      'Parameters: path (optional output PNG path), region (optional [x0,y0,x1,y1] fractions in 0..1 for a sub-area), scale (optional 0.1..1 downscale), keep_overlays (optional, keep existing panel marks when the geometry is unchanged — set true when re-shooting the same view mid-task).',
      'Returns { path, width, height, virtual_offset:[x,y], scale }. Add virtual_offset to a monitor-local pixel to target that monitor.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Optional PNG output path; empty writes a unique file under the configured screenshot dir.' },
      region: { type: 'array', items: { type: 'number' }, description: 'Optional [x0,y0,x1,y1] fractions (0..1) to capture a sub-area.' },
      scale: { type: 'number', description: 'Optional 0.1..1 downscale; defaults to 1.' },
      keep_overlays: { type: 'boolean', description: 'Keep existing panel overlays when the capture geometry is unchanged.' },
    },
    output: textOut('screenshot saved and shown in the right-sidebar panel'),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = gate('computer_screenshot')
      if (exec.signal.aborted) throw new Error('computer_screenshot: cancelled')
      const cwd = exec.agent?.session?.header?.cwd
      const frame = await capture({
        ...(args.path === undefined ? {} : { path: args.path }),
        ...(args.region === undefined ? {} : { region: args.region }),
        ...(args.scale === undefined ? {} : { scale: args.scale }),
        keepOverlays: args.keep_overlays === true,
        ...(cwd === undefined ? {} : { cwd }),
        signal: exec.signal,
      })
      void settings
      return { path: frame.path, width: frame.width, height: frame.height, virtual_offset: [...frame.virtualOffset], scale: frame.scale }
    },
  })

  const click = defineTool({
    name: 'computer_click',
    description: [
      linkNote(),
      `Click at a coordinate. ${HEAD}`,
      'Parameters: coordinate (required [x,y] screen pixels), action (optional click | right_click | double_click).',
      'Returns the clicked coordinate.',
    ].join(' '),
    parameters: {
      coordinate: COORD_REQUIRED,
      action: { type: 'string', enum: ['click', 'right_click', 'double_click'], description: 'Defaults to click.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_click')
      const [x, y] = asPair(args.coordinate)
      const action = args.action ?? 'click'
      const result = await port().pointer({ kind: 'click', x, y, action }, exec.signal)
      return { clicked: [...result.cursor] }
    },
  })

  const type = defineTool({
    name: 'computer_type',
    description: [
      linkNote(),
      `Type arbitrary UTF-16 text (Chinese included) at the current focus. ${HEAD}`,
      'Parameters: text (required), send_enter (optional). Uses SendInput KEYEVENTF_UNICODE, so CJK is entered reliably.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
      send_enter: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = gate('computer_type')
      const result = await port().type(args.text, {
        sendEnter: args.send_enter === true,
        intervalMs: settings.typing_interval_ms || 0,
      }, exec.signal)
      return { chars: result.chars }
    },
  })

  const keypress = defineTool({
    name: 'computer_keypress',
    description: [
      linkNote(),
      `Send a key chord, e.g. ["ctrl","c"] or ["alt","tab"]. ${HEAD}`,
      'Parameters: keys (required array of names: ctrl/control, shift, alt, super/win/cmd, enter, tab, esc, space, backspace, delete, home, end, pageup, pagedown, arrows, f1..f24, single letters/digits, or single punctuation).',
    ].join(' '),
    parameters: {
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Key names pressed together, modifiers first.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_keypress')
      const result = await port().keypress(args.keys, exec.signal)
      return { keys: result.keys }
    },
  })

  const scroll = defineTool({
    name: 'computer_scroll',
    description: [
      linkNote(),
      `Scroll at a coordinate. ${HEAD}`,
      'Parameters: coordinate (required [x,y]), direction (optional down | up | left | right), clicks (optional wheel notches, default from settings.scroll_units).',
    ].join(' '),
    parameters: {
      coordinate: COORD_REQUIRED,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Defaults to down.' },
      clicks: { type: 'number', description: 'Wheel notches; defaults to settings.scroll_units.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = gate('computer_scroll')
      const [x, y] = asPair(args.coordinate)
      const direction = args.direction ?? 'down'
      const clicks = typeof args.clicks === 'number' && args.clicks > 0 ? args.clicks : (settings.scroll_units || 1)
      await port().pointer({ kind: 'scroll', x, y, direction, clicks }, exec.signal)
      return { scrolled: `${direction} ${clicks} tick(s) at [${x}, ${y}]` }
    },
  })

  const drag = defineTool({
    name: 'computer_drag',
    description: [
      linkNote(),
      `Drag from start to end (press, interpolate, release). ${HEAD}`,
      'Parameters: start_coordinate (required [x,y]), end_coordinate (required [x,y]), hold_keys (optional, e.g. ["shift"]).',
    ].join(' '),
    parameters: {
      start_coordinate: COORD_REQUIRED,
      end_coordinate: { ...COORD, required: true },
      hold_keys: { type: 'array', items: { type: 'string' }, description: 'Modifiers held while dragging.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_drag')
      const from = asPair(args.start_coordinate)
      const to = asPair(args.end_coordinate)
      const holdKeys = args.hold_keys ?? []
      const result = await port().pointer({ kind: 'drag', from, to, holdKeys }, exec.signal)
      return { from: [...from], to: [...result.cursor] }
    },
  })

  const moveMouse = defineTool({
    name: 'computer_move_mouse',
    description: [
      linkNote(),
      `Move the pointer to a coordinate without clicking. ${HEAD}`,
      'Parameters: coordinate (required [x,y]). Read the result with computer_get_cursor_position.',
    ].join(' '),
    parameters: { coordinate: COORD_REQUIRED },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_move_mouse')
      const [x, y] = asPair(args.coordinate)
      const result = await port().pointer({ kind: 'move', x, y }, exec.signal)
      return { moved_to: [...result.cursor] }
    },
  })

  const wait = defineTool({
    name: 'computer_wait',
    description: 'Wait for a short period, e.g. to let a UI animation settle. No side effects. Parameters: ms (required).',
    parameters: { ms: { type: 'number', required: true, description: 'Duration in milliseconds.' } },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_wait')
      const ms = Math.max(0, Number(args.ms) || 0)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        exec.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('computer_wait: cancelled'))
        }, { once: true })
      })
      return { waited: ms }
    },
  })

  const getCursorPosition = defineTool({
    name: 'computer_get_cursor_position',
    description: 'Read the pointer position as screen pixels [x, y]. In link_mode=virtual this is the virtual pointer the panel shows; in real mode it is the OS cursor. No side effects.',
    parameters: {},
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      gate('computer_get_cursor_position')
      const [x, y] = await port().cursorPosition(exec.signal)
      return { x, y }
    },
  })

  const getVision = defineTool({
    name: 'computer_get_vision',
    description: [
      'Read the current desktop snapshot as structured facts instead of a picture: captured PNG size, virtual-screen origin, capture scale, the current pointer, the frame age, and every coordinate the USER has pointed at on the sidebar panel.',
      'Call this before acting: the numbers here are the exact ones computer_click / computer_move_mouse expect, and pending user instructions tell you what the user wants done.',
      'The same snapshot is visible to the user in the right-sidebar panel, so you and they are looking at one picture.',
      'No side effects. Parameters: none.',
    ].join(' '),
    parameters: {},
    output: textOut('desktop snapshot facts'),
    isConcurrencySafe: () => false,
    async execute() {
      gate('computer_get_vision')
      const frame = session.frame
      const { x, y } = session.cursor
      const instructions = session.pendingInstructions().map((instruction) => ({
        id: instruction.id,
        at: instruction.at,
        coordinate: [instruction.x, instruction.y],
        note: instruction.text ?? null,
      }))
      const overlays = session.snapshot().overlays.slice(-12).map((overlay) => ({
        kind: overlay.kind,
        at: [overlay.x, overlay.y],
        text: overlay.text ?? null,
      }))
      return {
        pointer: [x, y],
        frame: frame
          ? {
            path: frame.path,
            size: [frame.width, frame.height],
            virtual_offset: [...frame.virtualOffset],
            scale: frame.scale,
            viewport: [frame.viewport.width, frame.viewport.height],
            age_ms: Date.now() - frame.at,
            region: frame.region ? [...frame.region] : null,
          }
          : null,
        user_instructions: instructions,
        overlays,
      }
    },
  })

  const setModeTool = defineTool({
    name: 'computer_set_mode',
    description: [
      'Change the run mode: disabled / readonly / manual / auto.',
      'Only works when the setting「AI 可自行修改运行模式」(ai_can_change_mode) is on; otherwise it refuses.',
      'Parameters: mode (required).',
    ].join(' '),
    parameters: {
      mode: { type: 'string', enum: ['disabled', 'readonly', 'manual', 'auto'], required: true, description: 'Target run mode.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args) {
      gate('computer_set_mode')
      const mode = validateMode(args.mode)
      await setMode(mode)
      return { mode, changed_by: 'ai' }
    },
  })

  const setLinkModeTool = defineTool({
    name: 'computer_set_link_mode',
    description: [
      'Change where this plugin\'s actions land: virtual (the sidebar snapshot only — the real desktop and cursor stay untouched) or real (Win32 SendInput drives this machine).',
      'Only works when the setting「AI 可自行修改运行模式」(ai_can_change_mode) is on; otherwise it refuses.',
      'Switching to real takes over the user\'s actual mouse and keyboard, so prefer virtual unless the user explicitly asked for real control.',
      'Parameters: link_mode (required, virtual | real).',
    ].join(' '),
    parameters: {
      link_mode: { type: 'string', enum: ['virtual', 'real'], required: true, description: 'Target action target.' },
    },
    output: textOut(),
    isConcurrencySafe: () => false,
    async execute(args) {
      gate('computer_set_link_mode')
      const linkMode: LinkMode = args.link_mode
      await setLinkMode(linkMode)
      return { link_mode: linkMode, changed_by: 'ai' }
    },
  })

  return [
    screenshot,
    click,
    type,
    keypress,
    scroll,
    drag,
    moveMouse,
    wait,
    getCursorPosition,
    getVision,
    setModeTool,
    setLinkModeTool,
  ]
}

/** Validate a run mode against the allowed enum. */
function validateMode(value: unknown): RunMode {
  if (value !== 'disabled' && value !== 'readonly' && value !== 'manual' && value !== 'auto') {
    throw new Error('computer_set_mode: mode 必须是 disabled/readonly/manual/auto 之一')
  }
  return value
}

/** Read a two-element coordinate, rejecting anything else early. */
function asPair(value: readonly number[]): [number, number] {
  const x = Number(value[0])
  const y = Number(value[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要一个 [x, y] 坐标')
  return [x, y]
}
