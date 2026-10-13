/**
 * dsh-plugin-computer-user — virtual-desktop computer use for DeepSeek Harness.
 *
 * The problem this fork solves: upstream `computer-user` gives a text-only model
 * real control of the machine, but nothing to look at — the agent screenshots to
 * a temp file, acts on your actual cursor, and you find out afterwards. You
 * cannot watch it, and you cannot use your own computer while it works.
 *
 * So this plugin adds the missing half. The agent's screen is published to a
 * right-sidebar panel as a live snapshot, and the agent's mouse is drawn on top
 * of it as a virtual pointer you can watch move and click. By default nothing
 * reaches your real desktop (`link_mode: virtual`) — the agent plays on the panel
 * while you keep your cursor. Flip to `real` when you actually want it driving
 * the machine, and the panel becomes a mirror of what it is doing rather than a
 * substitute for it.
 *
 * Host half: the `computer_*` tools, the `/api/computer-user` routes, and the
 * capture loop that keeps the panel fresh. The browser half (`src/client.tsx`)
 * registers the panel itself.
 *
 * Settings namespace `computer-user`:
 *   mode — disabled / readonly / manual / auto
 *   link_mode — virtual (panel only) / real (SendInput)
 *   plus capture cadence, scale, approval, and the output guard.
 *
 * @module dsh-plugin-computer-user
 */

import { resolve as pathResolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { Config, NS, resolveSettings, type LinkMode, type RunMode, type Settings } from './config.ts'
import { createComputerTools } from './tools.ts'
import { capturePath, createRealPort, createVirtualPort, toFrame, type DesktopPort } from './ports.ts'
import { VirtualSession, type Frame, type SessionFrame } from './session.ts'
import { runPs } from './ps.ts'
import { createOutputGuard } from './output-guard.ts'
import { CaptureRetention } from './capture-retention.ts'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'dsh-computer-user'

/** Services required at runtime. */
export const inject = ['connection', 'tools']

/** Re-exported so the browser half and the tests share one schema. */
export { Config, NS }

/** Route prefix for the panel's own API. */
const BASE = '/api/computer-user'

/** One provider's adapter slot, as the LLM service holds it internally. */
interface AdapterRegistration {
  adapter: Record<string, unknown> & { stream: (options: unknown) => AsyncIterable<Record<string, unknown>> }
}

/**
 * The slice of the LLM service the output guard needs.
 *
 * `listProviders` is public and `on` is a service-wide event hook; the adapter
 * registry between them is not, so this is a structural view rather than an
 * import — the guard checks each piece before using it and disables itself
 * quietly if the shape ever moves.
 */
interface LlmAdapterHost {
  listProviders?: () => readonly string[]
  registration?: (provider: string) => AdapterRegistration | undefined
}

/** Every settings key a client may patch, and therefore the write allowlist. */
const PATCHABLE_KEYS = [
  'mode',
  'link_mode',
  'capture_interval_ms',
  'max_capture_width',
  'ai_can_change_mode',
  'screenshot_dir',
  'typing_interval_ms',
  'scroll_units',
  'output_guard',
  'debug',
] as const

/** JSON reply helper. */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Error reply helper. */
function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/** Read a JSON request body with the host's usual limits. */
async function body(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim()
  if (contentType !== 'application/json') throw new Error('Expected JSON')
  if (Number(request.headers.get('content-length') || 0) > 65_536) throw new Error('Request is too large')
  const value: unknown = await request.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

/**
 * Resolve every session identity a command invocation touches, so approval
 * follows the conversation across both identifiers the host uses.
 * @param invocation - the `/computer` invocation, however the host shaped it.
 * @returns the identities, or `__global__` when the host exposed none.
 */
export function sessionTargetsFromInvocation(invocation: unknown): Set<string> {
  const targets = new Set<string>()
  const agent = (invocation as { agent?: { id?: unknown; session?: { header?: { sessionId?: unknown } } } } | undefined)?.agent
  if (agent?.id) targets.add(String(agent.id))
  if (agent?.session?.header?.sessionId) targets.add(String(agent.session.header.sessionId))
  if (targets.size === 0) targets.add('__global__')
  return targets
}

/**
 * Flip approval for a set of session targets: if any is already approved,
 * revoke them all; otherwise approve them all.
 * @param approved - the live approval set.
 * @param targets - the identities to toggle.
 * @returns whether the sessions ended up approved.
 */
export function toggleApproval(approved: Set<string>, targets: ReadonlySet<string>): boolean {
  const wasApproved = [...targets].some((target) => approved.has(target))
  for (const target of targets) {
    if (wasApproved) approved.delete(target)
    else approved.add(target)
  }
  return !wasApproved
}

/** An SSE stream of session events, with replay, heartbeat, and abort handling. */
function eventStream(session: VirtualSession, request: Request, after: number): Response {
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const send = (frame: SessionFrame): void => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`id: ${frame.id}\ndata: ${JSON.stringify(frame.event)}\n\n`)) } catch { closed = true }
      }
      const stop = (close: boolean): void => {
        if (closed) return
        closed = true
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        request.signal.removeEventListener('abort', onAbort)
        if (close) { try { controller.close() } catch { /* the client already went away */ } }
      }
      const onAbort = (): void => stop(true)
      request.signal.addEventListener('abort', onAbort, { once: true })

      // A reconnecting panel replays what it missed, then follows live.
      for (const frame of session.replay(after)) send(frame)
      unsubscribe = session.subscribe((frame) => {
        // A `null` frame is a snapshot-only bump: the panel re-reads `/vision`.
        if (frame) send(frame)
        else if (!closed) {
          try { controller.enqueue(encoder.encode(`event: revision\ndata: ${session.snapshot().revision}\n\n`)) } catch { closed = true }
        }
      })
      heartbeat = setInterval(() => {
        if (closed) return
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { closed = true }
      }, 15_000)
      heartbeat.unref?.()
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Plugin body.
 * @param ctx - host context carrying `connection` and `tools`.
 * @param config - resolved plugin config (schema defaults already applied).
 */
export async function apply(ctx: Context, config: Settings): Promise<void> {
  const session = new VirtualSession()
  const captures = new CaptureRetention()
  const approvedSessions = new Set<string>()
  let settings: Settings = resolveSettings(config)

  // ── the port, swapped whenever link_mode changes ────────────────────────
  // Built lazily rather than up front so a settings flip takes effect on the
  // very next tool call, with no re-registration.
  let cachedLinkMode: LinkMode | null = null
  let cachedPort: DesktopPort | null = null
  const port = (): DesktopPort => {
    if (cachedPort && cachedLinkMode === settings.link_mode) return cachedPort
    cachedLinkMode = settings.link_mode
    cachedPort = settings.link_mode === 'real' ? createRealPort(session) : createVirtualPort(session)
    return cachedPort
  }
  const invalidatePort = (): void => {
    cachedPort = null
    cachedLinkMode = null
  }

  /** Persist a partial settings patch, or keep it in memory when no service exists. */
  let persist: ((patch: Record<string, unknown>) => Promise<void>) | null = null
  let restartCaptureLoop = (): void => {}
  const applyPatch = async (patch: Record<string, unknown>): Promise<void> => {
    const next = resolveSettings({ ...settings, ...patch } as Partial<Settings>)
    if (persist) await persist(patch)
    settings = next
    invalidatePort()
    restartCaptureLoop()
  }

  /**
   * Capture the screen and publish it to the panel.
   * @param options - output path, optional crop/scale, and whether to keep marks.
   * @returns the frame that is now on display.
   */
  const capture = async (options: {
    path?: string
    region?: readonly number[]
    scale?: number
    keepOverlays?: boolean
    transient?: boolean
    cwd?: string
    signal?: AbortSignal
  }): Promise<Frame> => {
    const cwd = options.cwd ?? process.cwd()
    const outPath = options.path ? pathResolve(cwd, options.path) : capturePath(cwd, settings.screenshot_dir)
    const region = Array.isArray(options.region) && options.region.length === 4
      ? [Number(options.region[0]), Number(options.region[1]), Number(options.region[2]), Number(options.region[3])] as [number, number, number, number]
      : undefined
    const result = await runPs('capture.ps1', {
      outPath,
      region: region ? [...region] : undefined,
      scale: typeof options.scale === 'number' ? options.scale : 1,
    }, options.signal ? { signal: options.signal } : {})
    const virtualOffset: [number, number] = Array.isArray(result.virtual_offset)
      ? [Number(result.virtual_offset[0]) || 0, Number(result.virtual_offset[1]) || 0]
      : [0, 0]
    const captured = {
      path: String(result.path ?? outPath),
      width: Number(result.width ?? 0),
      height: Number(result.height ?? 0),
      virtualOffset,
      scale: Number(result.scale ?? 1),
    }
    // The virtual screen's size, measured from the PNG plus the crop, NOT from
    // the PNG alone: `capture.ps1` shrinks the image by `scale` and crops it to
    // `region`, so the screen spans `png / scale / regionFraction`. Without this
    // the panel would call any coordinate past the cropped PNG out of bounds.
    const viewport = region
      ? {
        width: (captured.width / captured.scale) / Math.max(1e-6, region[2] - region[0]),
        height: (captured.height / captured.scale) / Math.max(1e-6, region[3] - region[1]),
      }
      : { width: captured.width / captured.scale, height: captured.height / captured.scale }
    const frame = toFrame(captured, viewport, region)
    session.setFrame(frame, options.keepOverlays ? { keepOverlays: true } : {})
    if (options.path === undefined) await captures.record(outPath, options.transient === true)
    return frame
  }

  // ── tools ───────────────────────────────────────────────────────────────
  const setMode = (mode: RunMode): Promise<void> => applyPatch({ mode })
  const setLinkMode = (mode: LinkMode): Promise<void> => applyPatch({ link_mode: mode })

  ctx.effect(() => {
    const tools = createComputerTools({
      getSettings: () => settings,
      port,
      session,
      approvedSessions,
      sessionIds: [],
      setMode,
      setLinkMode,
      capture,
    })
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-computer-user: tools')

  // ── settings namespace ──────────────────────────────────────────────────
  // The inject callback runs later, so a throw inside it would not be caught by
  // this try — and would silently take the /computer command and the output
  // guard down with it. Everything therefore degrades to the static config.
  try {
    ctx.inject(['settings'], (sctx) => {
      try {
        const service = sctx.settings as unknown as {
          register?: typeof sctx.settings.register
          describe?: () => Array<{ ns: string; value: unknown }>
          update?: (ns: string, patch: object) => Promise<void>
        }
        if (typeof service.register === 'function') {
          const scope = sctx.settings.register(NS, Config, { base: config })
          settings = resolveSettings(scope.get())
          persist = (patch) => scope.update(patch)
          scope.watch((next) => {
            settings = resolveSettings(next)
            invalidatePort()
            restartCaptureLoop()
          })
        } else if (typeof service.describe === 'function' && typeof service.update === 'function') {
          // DSH 0.2 projects each Loader entry as a settings form. The entry id,
          // rather than the old standalone namespace, is the write target. A
          // plugin's apply() can run before the Loader publishes its descriptor,
          // so resolve it when a write arrives, after startup has settled.
          const initial = service.describe().find(item => item.ns === name || item.ns === NS)
          if (initial) settings = resolveSettings(initial.value as Settings)
          persist = async (patch) => {
            const entry = service.describe!().find(item => item.ns === name || item.ns === NS)
            if (!entry) throw new Error(`settings entry ${name} is not available yet`)
            await service.update!(entry.ns, patch)
          }
          ctx.on('settings/document-updated', (ns) => {
            if (String(ns) !== name && String(ns) !== NS) return
            const entry = service.describe!().find(item => item.ns === name || item.ns === NS)
            if (!entry) return
            settings = resolveSettings(entry.value as Settings)
            invalidatePort()
            restartCaptureLoop()
          })
        } else {
          throw new Error('settings service has no supported write API')
        }
      } catch (cause) {
        persist = null
        ctx.logger?.warn?.(`[${name}] settings unavailable: ${String((cause as Error)?.message ?? cause)}`)
      }
    })
  } catch (cause) {
    ctx.logger?.warn?.(`[${name}] settings service not available: ${String((cause as Error)?.message ?? cause)}`)
  }

  // ── /computer approval command ──────────────────────────────────────────
  try {
    ctx.inject(['commands'], (sctx) => {
      sctx.commands.register({
        name: 'computer',
        description: '批准当前会话使用 computer-user 的全部工具（手动批准模式下需要）',
        handler: (invocation: unknown) => {
          const targets = sessionTargetsFromInvocation(invocation)
          const approved = toggleApproval(approvedSessions, targets)
          const ids = [...targets].join(', ')
          const where = settings.link_mode === 'virtual'
            ? '落点 virtual（只作用在右侧快照面板）'
            : '落点 real（会真正注入本机鼠标键盘）'
          return approved
            ? { kind: 'success', text: `✅ 已批准：computer-user 全部工具在当前会话可用（${ids}）· ${where}。后续轮次持续生效；再输入 /computer 可撤销。` }
            : { kind: 'success', text: `🔒 已撤销批准：有副作用的工具需重新 /computer 批准（${ids}）。` }
        },
      })
      ctx.logger?.info?.(`[${name}] /computer command registered`)
    })
  } catch (cause) {
    ctx.logger?.warn?.(`[${name}] commands service not available: ${String((cause as Error)?.message ?? cause)}`)
  }

  // ── output guard ────────────────────────────────────────────────────────
  // Wraps each provider adapter's `stream` so assistant TEXT that is really a
  // tool call written out as prose gets bounced once. Deliberately defended at
  // every hop: the adapter registry is internal to the LLM service, so the guard
  // treats it as best-effort and simply does not activate when the shape differs
  // — losing a formatting nudge is not worth losing the plugin.
  try {
    ctx.inject(['llm'], (sctx) => {
      const llm = sctx.llm as unknown as LlmAdapterHost | undefined
      const listProviders = llm?.listProviders?.bind(llm)
      const registrationOf = llm?.registration?.bind(llm)
      if (!listProviders || !registrationOf) {
        ctx.logger?.debug?.(`[${name}] output guard skipped: adapter registry not reachable`)
        return
      }
      const wrapProviders = (): void => {
        let wrapped = 0
        for (const provider of listProviders() ?? []) {
          let registration: AdapterRegistration | undefined
          try { registration = registrationOf(provider) } catch { continue }
          const adapter = registration?.adapter
          if (!registration || !adapter || adapter.__cuOutputGuard || typeof adapter.stream !== 'function') continue
          const originalStream = adapter.stream.bind(adapter)
          const proxy = new Proxy(adapter, {
            get(target, property, receiver) {
              if (property !== 'stream') {
                const value = Reflect.get(target, property, receiver)
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
              }
              return async function* guarded(options: unknown) {
                if (settings.output_guard === false) { yield* originalStream(options); return }
                const guard = createOutputGuard({ allowAfter: 2 })
                let noteShown = false
                for await (const chunk of originalStream(options)) {
                  if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                    const decision = guard.sniff(chunk.text)
                    if (decision.kind === 'reject') {
                      // One note per stream, and the polluted delta is dropped;
                      // the second identical attempt passes untouched.
                      if (!noteShown) {
                        noteShown = true
                        yield { ...chunk, text: decision.note }
                      }
                      continue
                    }
                  }
                  yield chunk
                }
              }
            },
          })
          Object.defineProperty(proxy, '__cuOutputGuard', { value: true, enumerable: false, configurable: true })
          registration.adapter = proxy
          wrapped += 1
        }
        if (wrapped > 0) ctx.logger?.info?.(`[${name}] output guard active on ${wrapped} provider(s)`)
      }
      wrapProviders()
      // Providers that register later get wrapped too, when the service exposes events.
      const events = sctx.llm as unknown as { on?: (event: string, listener: () => void) => unknown }
      if (typeof events.on === 'function') {
        try { events.on('provider/register', () => { try { wrapProviders() } catch { /* ignore */ } }) } catch { /* ignore */ }
      }
    })
  } catch (cause) {
    ctx.logger?.warn?.(`[${name}] output guard unavailable: ${String((cause as Error)?.message ?? cause)}`)
  }

  // ── routes ──────────────────────────────────────────────────────────────
  const unregister: Array<() => Promise<void>> = []
  ctx.effect(() => () => Promise.all(unregister.map((dispose) => dispose())).then(() => undefined), 'dsh-computer-user: routes')

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/status`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({
      mode: settings.mode,
      linkMode: settings.link_mode,
      captureIntervalMs: settings.capture_interval_ms,
      platform: process.platform,
      frame: session.frame,
      cursor: session.cursor,
    }),
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/frame`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const frame = session.frame
      if (!frame) return error('No frame captured yet', 404)
      // Only the frame the session itself produced may be served, so the route
      // cannot be talked into reading an arbitrary file.
      const requested = new URL(request.url).searchParams.get('path')
      if (requested && requested !== frame.path) return error('Unknown frame', 404)
      try {
        const bytes = await readFile(frame.path)
        const lower = frame.path.toLowerCase()
        const type = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
        return new Response(new Uint8Array(bytes), {
          headers: { 'content-type': type, 'cache-control': 'no-store', 'content-length': String(bytes.byteLength) },
        })
      } catch (cause) {
        return error(`Frame unavailable: ${String((cause as Error)?.message ?? cause)}`, 404)
      }
    },
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/vision`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(session.snapshot()),
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/events`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const cursor = Number(request.headers.get('last-event-id') || 0)
      const after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
      return eventStream(session, request, after)
    },
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/capture`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const value = await body(request)
        const region = Array.isArray(value.region) && value.region.length === 4 ? value.region.map(Number) : undefined
        const frame = await capture({
          transient: true,
          keepOverlays: value.keep_overlays === true,
          ...(region ? { region } : {}),
          ...(typeof value.scale === 'number' ? { scale: value.scale } : {}),
        })
        return json(frame, 201)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : 'Capture failed')
      }
    },
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/hint`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const value = await body(request)
        const x = Number(value.x)
        const y = Number(value.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return error('x and y must be numbers')
        const note = typeof value.text === 'string' && value.text.trim() ? value.text.trim() : undefined
        return json(session.hint(x, y, note), 201)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : 'Invalid hint')
      }
    },
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/hint-clear`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const value = await body(request)
        if (typeof value.id === 'number') return json({ dropped: session.dropInstruction(value.id) })
        session.clear(value.scope === 'all' ? 'all' : 'overlays')
        return json({ ok: true })
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : 'Invalid request')
      }
    },
  }))

  unregister.push(ctx.connection.fetch.register({
    path: `${BASE}/settings`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(settings)
      try {
        const value = await body(request)
        const patch: Record<string, unknown> = {}
        for (const key of PATCHABLE_KEYS) {
          if (value[key] !== undefined) patch[key] = value[key]
        }
        await applyPatch(patch)
        return json(settings)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : 'Invalid settings')
      }
    },
  }))

  // ── capture loop ────────────────────────────────────────────────────────
  // Keeps the panel live without the agent asking; stopped by the disposer.
  let timer: ReturnType<typeof setInterval> | undefined
  let capturing = false
  const stopLoop = (): void => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const startLoop = (): void => {
    stopLoop()
    const interval = Math.max(0, settings.capture_interval_ms)
    if (interval === 0 || process.platform !== 'win32') return
    timer = setInterval(() => {
      if (capturing) return
      capturing = true
      capture({ keepOverlays: true, transient: true })
        .catch((cause) => { ctx.logger?.debug?.(`[${name}] background capture failed: ${String((cause as Error)?.message ?? cause)}`) })
        .finally(() => { capturing = false })
    }, interval)
    timer.unref?.()
  }
  restartCaptureLoop = startLoop
  startLoop()
  ctx.effect(() => async () => { stopLoop(); await captures.dispose() }, 'dsh-computer-user: capture loop')

  if (settings.debug) {
    ctx.logger?.info?.(`[${name}] ready · mode=${settings.mode} link_mode=${settings.link_mode} platform=${process.platform}`)
  }
}

export default { name, inject, Config, apply }
